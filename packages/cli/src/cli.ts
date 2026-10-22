#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ComponentManifest, Theme } from "@genui/format";

const USAGE = `genui <command> [options]

Commands:
  publish [dir]                 Publish the component in dir (default .) to beta
  promote <name> [--version v]  Point stable at beta (or a specific version)       admin
  rollback <name> [--channel c] Move a channel (default stable) back one version   admin
  list                          Components and their channels
  theme <file.json> | --clear   Set or clear the workspace theme                   admin
  token <scope> <name>          Create a token (scope: server | publish | admin)   admin
  invite <email> [--role r]     Let someone manage the workspace in chat (member|admin)  admin

Options:
  --url <url>      Registry URL     (env GENUI_URL)
  --token <token>  Registry token   (env GENUI_TOKEN)

A component dir contains genui.component.json (manifest) and the built single-file HTML,
by default at dist/index.html (override with "bundle" in the manifest).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    version: { type: "string" },
    channel: { type: "string" },
    role: { type: "string" },
    clear: { type: "boolean" },
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

const url = (values.url ?? process.env.GENUI_URL ?? fail("missing --url or GENUI_URL")).replace(/\/$/, "");
const token = values.token ?? process.env.GENUI_TOKEN ?? fail("missing --token or GENUI_TOKEN");

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: unknown };
  if (!res.ok) fail(`${res.status} ${json.error ?? res.statusText}${json.issues ? `\n${JSON.stringify(json.issues, null, 2)}` : ""}`);
  return json;
}

async function publish(dir: string) {
  const manifestPath = resolve(dir, "genui.component.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8").catch(() => fail(`no genui.component.json in ${resolve(dir)}`))) as Record<string, unknown>;
  const parsed = ComponentManifest.safeParse(raw);
  if (!parsed.success) fail(`invalid manifest:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const bundlePath = resolve(dirname(manifestPath), typeof raw.bundle === "string" ? raw.bundle : "dist/index.html");
  const html = await readFile(bundlePath, "utf8").catch(() => fail(`bundle not found at ${bundlePath}; build it first`));
  const result = await api<{ version: string; hash: string }>("POST", "/v1/components", { manifest: parsed.data, html });
  console.log(`Published ${parsed.data.name}@${result.version} to beta (hash ${result.hash}). Promote with: genui promote ${parsed.data.name}`);
}

switch (command) {
  case "publish":
    await publish(args[0] ?? ".");
    break;
  case "promote": {
    const name = args[0] ?? fail("usage: genui promote <name> [--version v]");
    const result = await api<{ version: string }>("POST", `/v1/components/${name}/promote`, { version: values.version });
    console.log(`${name}: stable → ${result.version}`);
    break;
  }
  case "rollback": {
    const name = args[0] ?? fail("usage: genui rollback <name> [--channel beta|stable]");
    const channel = values.channel ?? "stable";
    const result = await api<{ version: string }>("POST", `/v1/components/${name}/rollback`, { channel });
    console.log(`${name}: ${channel} → ${result.version}`);
    break;
  }
  case "list": {
    const { components } = await api<{ components: { name: string; channels: Record<string, string>; versions: string[] }[] }>("GET", "/v1/components");
    if (!components.length) console.log("No components yet.");
    for (const c of components) console.log(`${c.name}  stable=${c.channels.stable ?? "-"}  beta=${c.channels.beta ?? "-"}  (${c.versions.length} versions)`);
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
    if (!scope || !name) fail("usage: genui token <server|publish|admin> <name>");
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
  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
