#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ComponentManifest, DEFAULT_ENVIRONMENT, EnvironmentName, Recipe, Theme } from "@genui/format";

const USAGE = `genui <command> [options]

Commands:
  dev [dir] [--port n]              Develop the component in dir (default .) in a local host; no registry needed
  publish [dir]                     Publish the component in dir (default .) to an environment      publish
  publish <name>@<version>          Serve an already published version in an environment, no rebuild  publish
  list                              Components and the version each environment serves
  env list                          Environments, their end-user MCP URLs and refresh URLs
  env add <name> | rm <name>        Create or delete an environment (prod always exists)             admin
  env set <name> --refresh-url <u>  Your server's refresh endpoint, called on changes ("" clears)    admin
  theme <file.json> | --clear       Set or clear an environment's theme                              admin
  token <scope> <name> [--env a,b]  Create a token (scope: server | publish | admin)                 admin
  invite <email> [--role r]         Let someone manage the workspace in chat (member|admin)          admin
  recipe list                       List an environment's recipes
  recipe set <file.json>            Create or replace a recipe from a JSON file                      admin
  recipe rm <name>                  Delete a recipe                                                  admin

Options:
  --url <url>      Registry URL     (env GENUI_URL)
  --token <token>  Registry token   (env GENUI_TOKEN)
  --env <name>     Environment for publish, theme and recipe (env GENUI_ENV, default prod)
  --json           Print the registry's response as JSON (publish, list, env list)

Token scopes: server reads (SDK); publish publishes to any environment, or with --env only to
those (CI); admin does everything.

An environment serves exactly what was last published to it, so publishing an older version
moves it back. Re-publishing the same version with the same bundle is a no-op, so CI jobs can be
re-run. A version never changes: to serve it in another environment, publish <name>@<version>.

A component dir contains a manifest (genui.component.json) and the built single-file HTML.
Built with @genui/kit/vite, both are generated into dist/. A hand-written manifest sits next to
the sources and points at dist/index.html by default (override with "bundle" in the manifest).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    env: { type: "string" },
    role: { type: "string" },
    clear: { type: "boolean" },
    "refresh-url": { type: "string" },
    json: { type: "boolean" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function fail(message: string): never {
  console.error(`genui: ${message}`);
  process.exit(1);
}

const [command, ...args] = positionals;
if (!command || values.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

// Only registry commands need these: `genui dev` runs without a registry.
function registry() {
  const url = (values.url ?? process.env.GENUI_URL ?? fail("missing --url or GENUI_URL")).replace(/\/$/, "");
  const token = values.token ?? process.env.GENUI_TOKEN ?? fail("missing --token or GENUI_TOKEN");
  return { url, token };
}

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = registry();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: unknown };
  if (!res.ok) fail(`${res.status} ${json.error ?? res.statusText}${json.issues ? `\n${JSON.stringify(json.issues, null, 2)}` : ""}`);
  return json;
}

/** Prints the registry's response with --json, else the human-readable text. */
function print(result: unknown, text: string) {
  console.log(values.json ? JSON.stringify(result, null, 2) : text);
}

/** --env, else GENUI_ENV, else prod. An unset CI variable often arrives as "", which means the default. */
function environment(): string {
  const name = values.env ?? (process.env.GENUI_ENV || DEFAULT_ENVIRONMENT);
  if (!EnvironmentName.safeParse(name).success) fail(`--env must be lowercase letters and digits, up to 15 characters (got "${name}")`);
  return name;
}

interface Published {
  version: string;
  hash: string;
  created: boolean;
  environment: string;
  environments: Record<string, string>;
  warnings: string[];
}

function printPublished(result: Published, what: string) {
  const pointers = Object.entries(result.environments)
    .map(([env, version]) => `${env}=${version}`)
    .join(" ");
  const lines = [`${what}. Now ${pointers}`, ...result.warnings.map((w) => `warning: breaking props change: ${w}`)];
  print(result, lines.join("\n"));
}

interface Environment {
  name: string;
  path: string;
  refreshUrl: string | null;
  lastRefresh: { at: string; ok: boolean; status?: number; error?: string } | null;
}

function describeEnvironment(e: Environment): string {
  const line = `${e.name}  ${registry().url}${e.path}`;
  if (!e.refreshUrl) return line;
  const last = e.lastRefresh;
  const outcome = !last ? "not called yet" : last.ok ? `last call ok (${last.at})` : `last call failed: ${last.error ?? `HTTP ${last.status}`} (${last.at})`;
  return `${line}\n  refresh ${e.refreshUrl}  ${outcome}`;
}

/** `rating@1.2.0`: a version that's already published. */
const REF = /^([a-z][a-z0-9_]{1,40})@(\d+\.\d+\.\d+)$/;

async function deploy(name: string, version: string) {
  const env = environment();
  const result = await api<Published>("PUT", `/v1/components/${name}/environments/${env}`, { version });
  printPublished(result, `${env} serves ${name}@${version} (hash ${result.hash})`);
}

async function publish(target: string) {
  const ref = REF.exec(target);
  if (ref) return deploy(ref[1]!, ref[2]!);
  const dir = target;
  const env = environment();
  // A hand-written manifest next to the sources, else the one @genui/kit/vite generates into dist/.
  const manifests = [resolve(dir, "genui.component.json"), resolve(dir, "dist/genui.component.json")];
  let manifestPath = "";
  let text: string | undefined;
  for (const candidate of manifests) {
    text = await readFile(candidate, "utf8").catch(() => undefined);
    manifestPath = candidate;
    if (text !== undefined) break;
  }
  if (text === undefined) fail(`no genui.component.json in ${resolve(dir)} or its dist/; build it first`);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const parsed = ComponentManifest.safeParse(raw);
  if (!parsed.success) fail(`invalid manifest:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const bundlePath = resolve(dirname(manifestPath), typeof raw.bundle === "string" ? raw.bundle : "dist/index.html");
  const html = await readFile(bundlePath, "utf8").catch(() => fail(`bundle not found at ${bundlePath}; build it first`));
  const { name } = parsed.data;
  const result = await api<Published>("POST", "/v1/components", { manifest: parsed.data, html, environment: env });
  const what = result.created ? `Published ${name}@${result.version} to ${env}` : `${name}@${result.version} was already published with this bundle; ${env} serves it`;
  printPublished(result, `${what} (hash ${result.hash})`);
}

/** Runs the component's dev server with the local host from @genui/kit, resolved from the component. */
async function dev(dir: string) {
  const root = resolve(dir);
  let entry: string;
  try {
    entry = createRequire(resolve(root, "package.json")).resolve("@genui/kit/dev");
  } catch {
    fail(`@genui/kit not found from ${root}. Add it to the component: pnpm add @genui/kit`);
  }
  const { startDev } = (await import(pathToFileURL(entry).href)) as {
    startDev(options: { root: string; port?: number }): Promise<{ printUrls(): void; bindCLIShortcuts(options: { print: boolean }): void }>;
  };
  const port = values.port === undefined ? undefined : Number(values.port);
  const server = await startDev({ root, port }).catch((error: Error) => fail(error.message));
  console.log("\n  genui dev: props form, theme and mock tools for your component\n");
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}

switch (command) {
  case "dev":
    await dev(args[0] ?? ".");
    break;
  case "publish":
    await publish(args[0] ?? ".");
    break;
  case "list": {
    const [{ components }, { environments }] = await Promise.all([
      api<{ components: { name: string; environments: Record<string, string>; versions: string[] }[] }>("GET", "/v1/components"),
      api<{ environments: { name: string }[] }>("GET", "/v1/environments"),
    ]);
    const lines = components.map((c) => {
      const served = environments.filter((e) => c.environments[e.name]).map((e) => `${e.name}=${c.environments[e.name]}`);
      return `${c.name}  ${served.length ? served.join("  ") : "(not served)"}  (${c.versions.length} versions)`;
    });
    print({ components }, lines.length ? lines.join("\n") : "No components yet.");
    break;
  }
  case "env": {
    const [action = "list", name] = args;
    if (action === "list") {
      const result = await api<{ environments: Environment[] }>("GET", "/v1/environments");
      print(result, result.environments.map(describeEnvironment).join("\n"));
    } else if (action === "set") {
      const target = name ?? fail("usage: genui env set <name> --refresh-url <url>");
      const url = values["refresh-url"] ?? fail("usage: genui env set <name> --refresh-url <url>  (\"\" clears it)");
      const updated = await api<Environment>("PUT", `/v1/environments/${target}`, { refreshUrl: url || null });
      print(
        updated,
        updated.refreshUrl
          ? `${target} calls ${updated.refreshUrl} after every publish, theme or recipe change.`
          : `${target} has no refresh URL; servers pick up changes at their next check.`,
      );
    } else if (action === "add") {
      const created = await api<{ name: string; path: string }>("POST", "/v1/environments", { name: name ?? fail("usage: genui env add <name>") });
      print(created, `Created ${created.name}. Its end-user MCP: ${registry().url}${created.path}\nPublish to it with: genui publish --env ${created.name}`);
    } else if (action === "rm") {
      await api("DELETE", `/v1/environments/${name ?? fail("usage: genui env rm <name>")}`);
      console.log(`Deleted ${name} with what it served: versions, theme and recipes.`);
    } else fail("usage: genui env list | add <name> | rm <name> | set <name> --refresh-url <url>");
    break;
  }
  case "theme": {
    const theme = values.clear ? null : Theme.parse(JSON.parse(await readFile(args[0] ?? fail("usage: genui theme <file.json> | --clear"), "utf8")));
    const env = environment();
    await api("PUT", `/v1/theme?environment=${env}`, { theme });
    console.log(theme ? `Theme updated in ${env}.` : `Theme cleared in ${env}.`);
    break;
  }
  case "token": {
    const [scope, name] = args;
    if (!scope || !name) fail("usage: genui token <server|publish|admin> <name> [--env a,b]");
    // Only an explicit --env limits a token; GENUI_ENV is for publishing.
    const environments = values.env?.split(",").map((e) => e.trim()).filter(Boolean);
    const result = await api<{ token: string }>("POST", "/v1/tokens", { scope, name, environments });
    console.log(result.token);
    break;
  }
  case "invite": {
    const email = args[0] ?? fail("usage: genui invite <email> [--role member|admin]");
    const result = await api<{ email: string; role: string }>("POST", "/v1/invites", { email, role: values.role ?? "member" });
    console.log(`Invited ${result.email} as ${result.role}. They get access at their first sign-in.`);
    break;
  }
  case "recipe": {
    const [action, arg] = args;
    const env = environment();
    const query = `?environment=${env}`;
    if (action === "list") {
      const { recipes } = await api<{ recipes: { name: string; when: string; form: { fields: unknown[] } }[] }>("GET", `/v1/recipes${query}`);
      if (!recipes.length) console.log(`No recipes in ${env} yet.`);
      for (const r of recipes) console.log(`/${r.name}  (${r.form.fields.length} fields)  ${r.when}`);
    } else if (action === "set") {
      const file = arg ?? fail("usage: genui recipe set <file.json> [--env e]");
      const parsed = Recipe.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) fail(`invalid recipe:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      const { name, ...rest } = parsed.data;
      const result = await api<{ replaced: boolean }>("PUT", `/v1/recipes/${name}${query}`, rest);
      console.log(`${result.replaced ? "Updated" : "Created"} recipe /${name} in ${env}.`);
    } else if (action === "rm") {
      await api("DELETE", `/v1/recipes/${arg ?? fail("usage: genui recipe rm <name> [--env e]")}${query}`);
      console.log(`Deleted recipe /${arg} from ${env}.`);
    } else fail("usage: genui recipe list | set <file.json> | rm <name> [--env e]");
    break;
  }
  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
