import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpUiHostContext, McpUiStyles } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { PlaygroundOAuth, takeCallback } from "./oauth";
import { PRESETS } from "./presets";

/**
 * Minimal MCP Apps host for local development: calls a render tool like a model would,
 * renders the returned ui:// view in a sandboxed iframe and logs what reaches the model.
 */

// Returning from sign-in: grab the code first; this restores the original ?server=… query.
const callback = takeCallback();
const params = new URLSearchParams(location.search);
const SERVER_URL = params.get("server") ?? "http://localhost:3001/mcp";

// Roughly Claude-like host variables, to check that views pick up host styling.
const HOST_VARS = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f5f4ef",
    "--color-text-primary": "#141413",
    "--color-text-secondary": "#5e5d59",
    "--color-border-primary": "#e8e6dc",
    "--font-sans": "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  dark: {
    "--color-background-primary": "#262624",
    "--color-background-secondary": "#30302e",
    "--color-text-primary": "#faf9f5",
    "--color-text-secondary": "#c2c0b6",
    "--color-border-primary": "#3e3e38",
    "--font-sans": "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const presetSelect = $<HTMLSelectElement>("preset");
const argsInput = $<HTMLTextAreaElement>("args");
const streamInput = $<HTMLInputElement>("stream");
const themeSelect = $<HTMLSelectElement>("theme");
const hostVarsInput = $<HTMLInputElement>("hostvars");
const stage = $<HTMLDivElement>("stage");
const log = $<HTMLPreElement>("log");

function write(label: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  log.textContent = `[${new Date().toLocaleTimeString()}] ${label}\n${text}\n\n${log.textContent}`;
}

// The presets, then (once connected) every other view tool the server lists.
const choices: Record<string, { tool: string; args: Record<string, unknown> }> = { ...PRESETS };
for (const name of Object.keys(choices)) presetSelect.add(new Option(name, name));
const loadPreset = () => (argsInput.value = JSON.stringify(choices[presetSelect.value]!.args, null, 2));
presetSelect.onchange = loadPreset;
loadPreset();
document.body.dataset.theme = themeSelect.value;
themeSelect.onchange = () => (document.body.dataset.theme = themeSelect.value);

// Servers that require OAuth (the registry MCP) trigger the sign-in flow on 401, like Claude's connectors.
const oauth = new PlaygroundOAuth(SERVER_URL);
const transport = () => new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: oauth });
if (callback) await transport().finishAuth(callback);
$<HTMLButtonElement>("signout").onclick = () => {
  oauth.signOut();
  location.reload();
};

const client = new Client({ name: "app-mcp-playground", version: "0.1.0" });
await client.connect(transport());
const { tools } = await client.listTools();
write("connected", { server: SERVER_URL, tools: tools.map((t) => t.name) });

const uiResource = (tool: (typeof tools)[number]) => (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;

// Views the presets don't cover (a company's own components), so any MCP Apps server can be tried here.
const presetTools = new Set(Object.values(PRESETS).map((p) => p.tool));
for (const tool of tools) {
  if (!uiResource(tool) || presetTools.has(tool.name)) continue;
  const name = `Server: ${tool.name}`;
  choices[name] = { tool: tool.name, args: {} };
  presetSelect.add(new Option(name, name));
}

function hostContext(): McpUiHostContext {
  const theme = themeSelect.value as "light" | "dark";
  return {
    theme,
    displayMode: "inline" as const,
    availableDisplayModes: ["inline", "fullscreen"],
    // Hosts may send any subset of the standard variables.
    ...(hostVarsInput.checked ? { styles: { variables: HOST_VARS[theme] as McpUiStyles } } : {}),
  };
}

/** Yields growing prefixes of the arguments, like a model streaming JSON. */
function* partials(args: Record<string, unknown>): Generator<Record<string, unknown>> {
  const listKey = Array.isArray(args.fields) ? "fields" : undefined;
  const rows = (args.data as { rows?: unknown[] } | undefined)?.rows;
  if (listKey) {
    const list = args[listKey] as unknown[];
    for (let i = 0; i <= list.length; i++) yield { ...args, [listKey]: list.slice(0, i) };
  } else if (rows) {
    for (let i = 0; i <= rows.length; i += 2) yield { ...args, data: { rows: rows.slice(0, i) } };
  } else {
    yield { type: args.type };
  }
}

type ToolResult = Parameters<AppBridge["sendToolResult"]>[0];

let current: { bridge: AppBridge; iframe: HTMLIFrameElement } | undefined;
/** The last call and its result, so Replay can render it again like a host re-rendering a stored message. */
let last: { tool: string; args: Record<string, unknown>; result: ToolResult } | undefined;

async function show(replay: boolean) {
  const preset = choices[presetSelect.value]!;
  if (replay && !last) return write("error", "Nothing to replay yet: call a tool first.");
  const call = replay ? last! : { tool: preset.tool, args: JSON.parse(argsInput.value) as Record<string, unknown> };
  const args = call.args;
  const tool = tools.find((t) => t.name === call.tool);
  const uri = tool && uiResource(tool);
  if (!uri) return write("error", `${call.tool} has no ui resource`);

  if (current) {
    await current.bridge.teardownResource({}).catch(() => {});
    current.iframe.remove();
  }

  const resource = await client.readResource({ uri });
  const html = (resource.contents[0] as { text: string }).text;
  write("resource", `${uri} (${Math.round(html.length / 1024)} KB)`);

  const t0 = performance.now();
  const iframe = document.createElement("iframe");
  // Like real hosts (the MCP Apps spec requires allow-same-origin), so views can keep state in localStorage.
  // Here that origin is the playground's own; real hosts give views a separate one.
  iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
  iframe.srcdoc = html;
  stage.replaceChildren(iframe);

  const bridge = new AppBridge(
    client,
    { name: "app-mcp-playground", version: "0.1.0" },
    { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: { text: {} }, message: { text: {} } },
    { hostContext: hostContext() },
  );
  current = { bridge, iframe };

  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${height}px`;
  };
  bridge.onupdatemodelcontext = async (params) => {
    write("→ model context (updateModelContext)", params.content?.map((c) => ("text" in c ? c.text : c)) ?? params);
    return {};
  };
  bridge.onmessage = async (params) => {
    write(
      "→ chat message (sendMessage)",
      params.content.map((c) => ("text" in c ? c.text : c)),
    );
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    document.body.classList.toggle("fullscreen", mode === "fullscreen");
    bridge.sendHostContextChange({ ...hostContext(), displayMode: mode });
    return { mode };
  };
  themeSelect.onchange = () => {
    document.body.dataset.theme = themeSelect.value;
    bridge.sendHostContextChange(hostContext());
  };

  bridge.oninitialized = async () => {
    write("view initialized", `${Math.round(performance.now() - t0)} ms after iframe creation`);
    try {
      if (streamInput.checked && !replay) {
        let n = 0;
        for (const partial of partials(args)) {
          await bridge.sendToolInputPartial({ arguments: partial });
          n++;
          await new Promise((r) => setTimeout(r, 250));
        }
        write("streamed partial inputs", n);
      }
      await bridge.sendToolInput({ arguments: args });
      const result = replay ? last!.result : ((await client.callTool({ name: call.tool, arguments: args })) as ToolResult);
      write(`${call.tool} result${replay ? " (replayed)" : ""}`, result);
      if (!replay) last = { tool: call.tool, args, result };
      await bridge.sendToolResult(result);
    } catch (error) {
      write("host error", String(error));
    }
  };

  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
}

$<HTMLButtonElement>("run").onclick = () => void show(false);
$<HTMLButtonElement>("replay").onclick = () => void show(true);
