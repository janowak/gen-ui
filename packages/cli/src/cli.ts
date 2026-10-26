#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Branding, DEFAULT_ENVIRONMENT, EnvironmentName, Guide, Recipe, Theme } from "@genui/format";
import { readComponentDir } from "@genui/runtime/local";
import type { ServeOptions } from "@genui/runtime/serve";
import { init } from "./init.js";

/** genui cloud. Self-hosted registries pass --url or GENUI_URL. */
const DEFAULT_URL = "https://api.app-mcp.com";

const USAGE = `genui <command> [options]

Commands:
  init [dir] [--name n]             Start a new component in dir (default .), ready for dev and publish
  dev [dir] [--port n]              Develop the component in dir (default .) in a local host; no registry needed
  serve [dirs...]                   A local genui MCP with these components (default . if it is one);
                                    no registry, account or token. See "serve options" below
  publish [dir]                     Publish the component in dir (default .) to an environment      publish
  publish <name>@<version>          Serve an already published version in an environment, no rebuild  publish
  remove <name>                     Stop serving a component in an environment; versions stay       publish
  list                              Components and the version each environment serves
  env list                          Environments, their end-user MCP URLs and refresh URLs
  env add <name> | rm <name>        Create or delete an environment (prod always exists)             admin
  env set <name> --refresh-url <u>  Your server's refresh endpoint, called on changes ("" clears)    admin
  env set <name> --built-ins on|off The built-in render_form and render_chart                         admin
  theme <file.json> | --clear       Set or clear an environment's theme                              admin
  token <scope> <name> [--env a,b]  Create a token (scope: server | publish | admin)                 admin
  recipe list                       List an environment's recipes
  recipe set <file.json>            Create or replace a recipe from a JSON file                      admin
  recipe rm <name>                  Delete a recipe                                                  admin
  guide <file.json> | --clear       Set or clear an environment's MCP instructions and workflow prompts admin
  branding <file.json>              Set the connector's title, description and website               admin
  icon <image> | --clear            Set or clear the connector icon (PNG, JPEG, WebP or SVG, 100 KB) admin

Options:
  --url <url>      Registry URL     (env GENUI_URL, default ${DEFAULT_URL})
  --token <token>  Registry token   (env GENUI_TOKEN)
  --env <name>     Environment for publish, theme, recipe and guide (env GENUI_ENV, default prod)
  --json           Print the registry's response as JSON (publish, list, env list)

Token scopes: server reads (SDK); publish publishes to any environment, or with --env only to
those (CI); admin does everything.

An environment serves exactly what was last published to it, so publishing an older version
moves it back. Re-publishing the same version with the same bundle is a no-op, so CI jobs can be
re-run. A version never changes: to serve it in another environment, publish <name>@<version>.

Serve options:
  --theme <file.json>   Theme              --recipes <file.json|dir>  Recipe file or directory of them
  --guide <file.json>   MCP instructions and workflow prompts
  --port <n>            HTTP port (default 4100)     --host <name>  Interface (default 127.0.0.1)
  --stdio               Serve over stdin/stdout, for hosts that start the MCP as a command
  --suffix <name>       End tool names in _<name>, to sit next to prod's connector in one chat
  --refresh-url <url>   POSTed on every change, like an environment's refresh URL
  --no-build            Don't run the components' watch builds; serve dist/ as it is
Everything reloads on save: components with a vite.config are rebuilt, and connected clients get
the new tools. Without a token, clients only render (no data tools); @genui/sdk passes any token
(e.g. "local") and gets data tools, as with a server token on the registry.

A component dir contains a manifest (genui.component.json) and the built single-file HTML.
Built with @genui/kit/vite, both are generated into dist/. A hand-written manifest sits next to
the sources and points at dist/index.html by default (override with "bundle" in the manifest).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    env: { type: "string" },
    clear: { type: "boolean" },
    "refresh-url": { type: "string" },
    "built-ins": { type: "string" },
    name: { type: "string" },
    json: { type: "boolean" },
    port: { type: "string" },
    theme: { type: "string" },
    recipes: { type: "string" },
    guide: { type: "string" },
    host: { type: "string" },
    stdio: { type: "boolean" },
    suffix: { type: "string" },
    "no-build": { type: "boolean" },
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
  const url = (values.url ?? (process.env.GENUI_URL || DEFAULT_URL)).replace(/\/$/, "");
  const token = values.token ?? process.env.GENUI_TOKEN ?? fail("missing --token or GENUI_TOKEN: create one in the genui connector, under Workspace → Tokens");
  return { url, token };
}

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = registry();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  }).catch((error: Error) => fail(`can't reach the registry at ${url}: ${(error.cause as Error | undefined)?.message || error.message}`));
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
  builtIns: boolean;
}

function describeEnvironment(e: Environment): string {
  const line = `${e.name}  ${registry().url}${e.path}${e.builtIns ? "" : "  (built-in forms and charts off)"}`;
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
  const env = environment();
  const { manifest, html } = await readComponentDir(target).catch((error: Error) => fail(error.message));
  const { name } = manifest;
  const result = await api<Published>("POST", "/v1/components", { manifest, html, environment: env });
  const what = result.created ? `Published ${name}@${result.version} to ${env}` : `${name}@${result.version} was already published with this bundle; ${env} serves it`;
  printPublished(result, `${what} (hash ${result.hash})`);
}

interface KitDev {
  startDev(options: { root: string; port?: number }): Promise<{ printUrls(): void; bindCLIShortcuts(options: { print: boolean }): void }>;
  watchBuild?(options: { root: string; onBuild?(error?: Error): void }): Promise<{ close(): Promise<void> }>;
}

/** @genui/kit's dev tools, resolved from the component so they match the kit it builds with. */
async function kitDev(root: string): Promise<KitDev | undefined> {
  let entry: string;
  try {
    entry = createRequire(resolve(root, "package.json")).resolve("@genui/kit/dev");
  } catch {
    return undefined;
  }
  return (await import(pathToFileURL(entry).href)) as KitDev;
}

const exists = (path: string) => access(path).then(() => true, () => false);
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

/** Runs the component's dev server with the local host from @genui/kit, resolved from the component. */
async function dev(dir: string) {
  const root = resolve(dir);
  const { startDev } = (await kitDev(root)) ?? fail(`@genui/kit not found from ${root}. Add it to the component: pnpm add @genui/kit`);
  const port = values.port === undefined ? undefined : Number(values.port);
  const server = await startDev({ root, port }).catch((error: Error) => fail(error.message));
  console.log("\n  genui dev: props form, theme and mock tools for your component\n");
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}

/** A local genui MCP for these component dirs: no registry, account or token. */
async function serve(dirs: string[]) {
  const log = (line: string) => console.error(`  ${line}`);
  // Over stdio, stdout carries the protocol: anything else printed there would break it.
  if (values.stdio) console.log = console.error;
  if (!dirs.length) {
    const here = ["genui.component.json", "dist/genui.component.json", ...VITE_CONFIGS].map((file) => resolve(file));
    if ((await Promise.all(here.map(exists))).some(Boolean)) dirs = ["."];
  }
  const suffix = values.suffix === undefined ? undefined : EnvironmentName.safeParse(values.suffix).success ? values.suffix : fail(`--suffix: lowercase letters and digits, up to 15 characters`);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isInteger(port)) fail("--port must be a number");

  const build: ServeOptions["build"] = async (dir, onBuild) => {
    const root = resolve(dir);
    if (values["no-build"] || !(await Promise.all(VITE_CONFIGS.map((file) => exists(resolve(root, file))))).some(Boolean)) return undefined;
    const kit = await kitDev(root);
    if (!kit?.watchBuild) {
      log(`not building ${dir}: @genui/kit with watchBuild not found from it; serving its dist/ as it is`);
      return undefined;
    }
    log(`building ${dir} (rebuilds on save)`);
    return kit.watchBuild({ root, onBuild });
  };

  const { startServe } = await import("@genui/runtime/serve");
  const served = await startServe({
    dirs,
    theme: values.theme,
    recipes: values.recipes,
    guide: values.guide,
    port,
    host: values.host,
    stdio: values.stdio,
    suffix,
    refreshUrl: values["refresh-url"],
    build,
    log,
  }).catch((error: Error) => fail(error.message));

  const tools = served.catalog.components().map((c) => `render_${c.manifest.name}${suffix ? `_${suffix}` : ""} (${c.manifest.name}@${c.manifest.version})`);
  const recipes = (await served.catalog.snapshot(suffix ?? DEFAULT_ENVIRONMENT))?.catalog.recipes.length ?? 0;
  const lines = [
    `serving render_form, render_chart${tools.length ? `, ${tools.join(", ")}` : ""}${recipes ? `, use_recipe (${recipes} recipe${recipes === 1 ? "" : "s"})` : ""}`,
  ];
  if (served.url) {
    lines.unshift(
      `genui serve: ${served.url}`,
      `Claude Code: claude mcp add --transport http genui ${served.url}`,
      `@genui/sdk:  connectGenUI({ url: "${served.url}", token: "local" })`,
    );
  } else {
    lines.unshift("genui serve over stdio");
  }
  console.error(`\n${lines.map((line) => `  ${line}`).join("\n")}\n`);

  const stop = () => void served.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (values.stdio) process.stdin.on("close", stop);
}

switch (command) {
  case "init": {
    const dir = args[0] ?? ".";
    const name = await init(dir, values.name).catch((error: Error) => fail(error.message));
    const cd = dir === "." ? "" : `cd ${dir} && `;
    console.log(`Created the ${name} component in ${resolve(dir)}.

  ${cd}npm install
  npm run dev                                       # try it in a local host
  GENUI_TOKEN=<publish token> npm run genui:publish  # publish it to your workspace`);
    break;
  }
  case "dev":
    await dev(args[0] ?? ".");
    break;
  case "serve":
    await serve(args);
    break;
  case "publish":
    await publish(args[0] ?? ".");
    break;
  case "remove": {
    const name = args[0] ?? fail("usage: genui remove <name> [--env e]");
    const env = environment();
    await api("DELETE", `/v1/components/${name}/environments/${env}`);
    console.log(`${env} no longer serves ${name}. Its versions stay published: genui publish ${name}@<version> --env ${env} serves one again.`);
    break;
  }
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
      const usage = "usage: genui env set <name> [--refresh-url <url>] [--built-ins on|off]  (--refresh-url \"\" clears it)";
      const target = name ?? fail(usage);
      const url = values["refresh-url"];
      const builtIns = values["built-ins"];
      if (url === undefined && builtIns === undefined) fail(usage);
      if (builtIns !== undefined && builtIns !== "on" && builtIns !== "off") fail("--built-ins must be on or off");
      const updated = await api<Environment>("PUT", `/v1/environments/${target}`, {
        ...(url !== undefined ? { refreshUrl: url || null } : {}),
        ...(builtIns !== undefined ? { builtIns: builtIns === "on" } : {}),
      });
      const lines = [];
      if (url !== undefined) {
        lines.push(
          updated.refreshUrl
            ? `${target} calls ${updated.refreshUrl} after every publish, theme or recipe change.`
            : `${target} has no refresh URL; servers pick up changes at their next check.`,
        );
      }
      if (builtIns !== undefined) lines.push(`${target} ${updated.builtIns ? "offers" : "no longer offers"} the built-in render_form and render_chart.`);
      print(updated, lines.join("\n"));
    } else if (action === "add") {
      const created = await api<{ name: string; path: string }>("POST", "/v1/environments", { name: name ?? fail("usage: genui env add <name>") });
      print(created, `Created ${created.name}. Its end-user MCP: ${registry().url}${created.path}\nPublish to it with: genui publish --env ${created.name}`);
    } else if (action === "rm") {
      await api("DELETE", `/v1/environments/${name ?? fail("usage: genui env rm <name>")}`);
      console.log(`Deleted ${name} with what it served: versions, theme and recipes.`);
    } else fail("usage: genui env list | add <name> | rm <name> | set <name> [--refresh-url <url>] [--built-ins on|off]");
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
  case "guide": {
    const env = environment();
    const parse = async (file: string) => {
      const parsed = Guide.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) fail(`invalid guide:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      return parsed.data;
    };
    const guide = values.clear ? { prompts: [] } : await parse(args[0] ?? fail("usage: genui guide <file.json> | --clear [--env e]"));
    await api("PUT", `/v1/guide?environment=${env}`, guide);
    console.log(values.clear ? `Instructions and workflow prompts cleared in ${env}.` : `Instructions and ${guide.prompts.length} workflow prompt(s) saved in ${env}.`);
    break;
  }
  case "branding": {
    const branding = Branding.parse(JSON.parse(await readFile(args[0] ?? fail("usage: genui branding <file.json>"), "utf8")));
    print(await api("PUT", "/v1/branding", branding), "Branding updated. Hosts show it the next time they connect.");
    break;
  }
  case "icon": {
    if (values.clear) await api("DELETE", "/v1/branding/icon");
    else await api("PUT", "/v1/branding/icon", new Uint8Array(await readFile(args[0] ?? fail("usage: genui icon <image> | --clear"))));
    console.log(values.clear ? "Icon cleared." : "Icon updated. Hosts show it the next time they connect.");
    break;
  }
  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
