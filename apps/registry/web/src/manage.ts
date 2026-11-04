import "./style.css";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { $, authClient } from "./client";

/**
 * The web console: a small MCP Apps host for people who'd rather click than chat. It calls the management
 * MCP at /manage/mcp with the session cookie and shows the same views the AI assistant shows, one per tab.
 */

/** A tab per management view, shown when the person's role has its tool. */
const TABS = [
  { id: "workspace", label: "Workspace", tool: "show_workspace" },
  { id: "people", label: "People", tool: "list_members" },
  { id: "components", label: "Components", tool: "manage_components" },
  { id: "tokens", label: "Tokens", tool: "list_tokens" },
  { id: "connector", label: "Connector", tool: "edit_connector" },
  { id: "theme", label: "Theme", tool: "open_theme_controller" },
  { id: "workflows", label: "Workflows", tool: "manage_workflows" },
  { id: "instructions", label: "Instructions", tool: "manage_instructions" },
] as const;
type Tab = (typeof TABS)[number];
type ToolResult = Parameters<AppBridge["sendToolResult"]>[0];

const HOST = { name: "app-mcp-web", version: "0.1.0" };
const stage = $<HTMLElement>("stage");
const error = $<HTMLDivElement>("error");
const environmentSelect = $<HTMLSelectElement>("environment");
const dark = matchMedia("(prefers-color-scheme: dark)");

const fail = (message: string) => (error.textContent = message);

const session = await authClient.getSession();
if (!session.data) location.replace("/sign-in");
$<HTMLSpanElement>("me").textContent = session.data?.user.email ?? "";
$<HTMLButtonElement>("signout").onclick = async () => {
  await authClient.signOut();
  location.href = "/sign-in";
};

const client = new Client(HOST);
await client.connect(new StreamableHTTPClientTransport(new URL("/manage/mcp", location.origin))).catch((err: Error) => {
  fail(`Could not open the workspace: ${err.message}`);
  throw err;
});
const { tools } = await client.listTools();
const resourceUri = (name: string) =>
  (tools.find((t) => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
const tabs = TABS.filter((tab) => resourceUri(tab.tool));

/** Structured content of a tool, for the header; the views get the full result. */
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as { text?: string }[])[0]?.text ?? `${name} failed`);
  return result.structuredContent as T;
}

/** The workspace name and the environment the views show, re-read on every tab since the views can change both. */
async function header() {
  const [workspace, components] = await Promise.all([
    call<{ workspace: { name: string } }>("show_workspace"),
    call<{ environment: string; environments: string[] }>("manage_components"),
  ]);
  $<HTMLSpanElement>("workspace").textContent = workspace.workspace.name;
  environmentSelect.replaceChildren(...components.environments.map((name) => new Option(name, name)));
  environmentSelect.value = components.environment;
  $<HTMLLabelElement>("environment-picker").hidden = components.environments.length < 2;
}

environmentSelect.onchange = async () => {
  try {
    await call("use_environment", { name: environmentSelect.value });
    void show(selected());
  } catch (err) {
    fail((err as Error).message);
  }
};

const nav = $<HTMLElement>("tabs");
for (const tab of tabs) {
  const link = document.createElement("a");
  link.href = `#${tab.id}`;
  link.textContent = tab.label;
  link.dataset.tab = tab.id;
  nav.append(link);
}
const selected = (): Tab => tabs.find((tab) => `#${tab.id}` === location.hash) ?? tabs[0]!;
addEventListener("hashchange", () => void show(selected()));

let displayMode: McpUiDisplayMode = "inline";
const hostContext = (): McpUiHostContext => ({
  theme: dark.matches ? "dark" : "light",
  displayMode,
  availableDisplayModes: ["inline", "fullscreen"],
});

let current: { bridge: AppBridge; iframe: HTMLIFrameElement } | undefined;
dark.onchange = () => current?.bridge.sendHostContextChange(hostContext());

/** Renders a tab's view and calls its tool, the way an AI assistant does when the model calls it. */
async function show(tab: Tab) {
  for (const link of nav.querySelectorAll("a")) link.toggleAttribute("aria-current", link.dataset.tab === tab.id);
  error.textContent = "";
  if (current) {
    await current.bridge.teardownResource({}).catch(() => {});
    current.iframe.remove();
    current = undefined;
  }
  void header().catch((err: Error) => fail(err.message));

  const uri = resourceUri(tab.tool)!;
  const resource = await client.readResource({ uri });
  const content = resource.contents[0] as { text: string; _meta?: { ui?: { permissions?: { clipboardWrite?: object } } } };
  const iframe = document.createElement("iframe");
  iframe.title = tab.label;
  // allow-same-origin as the MCP Apps spec asks of hosts, so views keep their state. These are the registry's
  // own views, so sharing its origin is fine; this page never renders published components.
  iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
  if (content._meta?.ui?.permissions?.clipboardWrite) iframe.allow = "clipboard-write";
  iframe.srcdoc = content.text;
  stage.replaceChildren(iframe);

  const bridge = new AppBridge(
    client,
    HOST,
    { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
    { hostContext: hostContext() },
  );
  current = { bridge, iframe };
  bridge.onsizechange = ({ height }) => {
    if (height && displayMode === "inline") iframe.style.height = `${height}px`;
  };
  // There's no model here: what the views tell it goes nowhere.
  bridge.onupdatemodelcontext = async () => ({});
  bridge.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener");
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    displayMode = mode === "fullscreen" ? "fullscreen" : "inline";
    document.body.classList.toggle("fullscreen", displayMode === "fullscreen");
    bridge.sendHostContextChange(hostContext());
    return { mode: displayMode };
  };
  bridge.oninitialized = async () => {
    try {
      await bridge.sendToolInput({ arguments: {} });
      await bridge.sendToolResult((await client.callTool({ name: tab.tool, arguments: {} })) as ToolResult);
    } catch (err) {
      fail((err as Error).message);
    }
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
}

addEventListener("keydown", (event) => {
  if (event.key === "Escape" && displayMode === "fullscreen" && current) {
    displayMode = "inline";
    document.body.classList.remove("fullscreen");
    current.bridge.sendHostContextChange(hostContext());
  }
});

await show(selected());
