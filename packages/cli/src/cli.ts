#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Channel, CHANNELS, ComponentManifest, Recipe, Theme } from "@genui/format";

const USAGE = `genui <command> [options]

Commands:
  dev [dir] [--port n]          Develop the component in dir (default .) in a local host; no registry needed
  publish [dir]                 Publish the component in dir (default .) to beta
          [--channel stable]    ...or straight to stable (env GENUI_CHANNEL)       release
  promote <name> [--version v]  Point stable at beta (or a specific version)       release
  rollback <name> [--channel c] Move a channel (default stable) back one version   release
  list                          Components and their channels
  theme <file.json> | --clear   Set or clear the workspace theme                   admin
  token <scope> <name>          Create a token (scope: server | publish | release | admin)  admin
  invite <email> [--role r]     Let someone manage the workspace in chat (member|admin)  admin
  recipe list                   List recipes
  recipe set <file.json>        Create or replace a recipe from a JSON file        admin
  recipe rm <name>              Delete a recipe                                    admin

Options:
  --url <url>      Registry URL     (env GENUI_URL)
  --token <token>  Registry token   (env GENUI_TOKEN)
  --json           Print the registry's response as JSON (publish, promote, rollback, list)

Token scopes: server reads (SDK); publish publishes to beta (CI); release also publishes to
stable, promotes and rolls back (CI); admin does everything.

Re-publishing the same version with the same bundle is a no-op, so CI jobs can be re-run.
Publishing never moves a channel back; promote --version and rollback do.

A component dir contains a manifest (genui.component.json) and the built single-file HTML.
Built with @genui/kit/vite, both are generated into dist/. A hand-written manifest sits next to
the sources and points at dist/index.html by default (override with "bundle" in the manifest).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    version: { type: "string" },
    channel: { type: "string" },
    role: { type: "string" },
    clear: { type: "boolean" },
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

async function publish(dir: string) {
  // An unset CI variable often arrives as "", which means the default.
  const channel = Channel.safeParse(values.channel ?? (process.env.GENUI_CHANNEL || "beta"));
  if (!channel.success) fail(`--channel must be one of: ${CHANNELS.join(", ")}`);
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
  const result = await api<{ version: string; hash: string; created: boolean; channels: Partial<Record<Channel, string>> }>("POST", "/v1/components", {
    manifest: parsed.data,
    html,
    channel: channel.data,
  });
  const pointers = CHANNELS.map((c) => `${c}=${result.channels[c] ?? "-"}`).join(" ");
  const what = result.created ? `Published ${name}@${result.version}` : `${name}@${result.version} was already published with this bundle`;
  const lines = [`${what} (hash ${result.hash}). Now ${pointers}`];
  if (result.channels.stable !== result.version) lines.push(`Promote with: genui promote ${name} --version ${result.version}`);
  print(result, lines.join("\n"));
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
  case "promote": {
    const name = args[0] ?? fail("usage: genui promote <name> [--version v]");
    const result = await api<{ version: string }>("POST", `/v1/components/${name}/promote`, { version: values.version });
    print(result, `${name}: stable → ${result.version}`);
    break;
  }
  case "rollback": {
    const name = args[0] ?? fail("usage: genui rollback <name> [--channel beta|stable]");
    const channel = values.channel ?? "stable";
    const result = await api<{ version: string }>("POST", `/v1/components/${name}/rollback`, { channel });
    print(result, `${name}: ${channel} → ${result.version}`);
    break;
  }
  case "list": {
    const result = await api<{ components: { name: string; channels: Record<string, string>; versions: string[] }[] }>("GET", "/v1/components");
    const lines = result.components.map((c) => `${c.name}  stable=${c.channels.stable ?? "-"}  beta=${c.channels.beta ?? "-"}  (${c.versions.length} versions)`);
    print(result, lines.length ? lines.join("\n") : "No components yet.");
    break;
  }
  case "theme": {
    const theme = values.clear ? null : Theme.parse(JSON.parse(await readFile(args[0] ?? fail("usage: genui theme <file.json> | --clear"), "utf8")));
    await api("PUT", "/v1/theme", { theme });
    console.log(theme ? "Theme updated." : "Theme cleared.");
    break;
  }
  case "token": {
    const [scope, name] = args;
    if (!scope || !name) fail("usage: genui token <server|publish|release|admin> <name>");
    const result = await api<{ token: string }>("POST", "/v1/tokens", { scope, name });
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
    if (action === "list") {
      const { recipes } = await api<{ recipes: { name: string; when: string; form: { fields: unknown[] } }[] }>("GET", "/v1/recipes");
      if (!recipes.length) console.log("No recipes yet.");
      for (const r of recipes) console.log(`/${r.name}  (${r.form.fields.length} fields)  ${r.when}`);
    } else if (action === "set") {
      const file = arg ?? fail("usage: genui recipe set <file.json>");
      const parsed = Recipe.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) fail(`invalid recipe:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      const { name, ...rest } = parsed.data;
      const result = await api<{ replaced: boolean }>("PUT", `/v1/recipes/${name}`, rest);
      console.log(`${result.replaced ? "Updated" : "Created"} recipe /${name}.`);
    } else if (action === "rm") {
      await api("DELETE", `/v1/recipes/${arg ?? fail("usage: genui recipe rm <name>")}`);
      console.log(`Deleted recipe /${arg}.`);
    } else fail("usage: genui recipe list | set <file.json> | rm <name>");
    break;
  }
  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
