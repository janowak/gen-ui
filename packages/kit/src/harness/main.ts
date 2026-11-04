import { PREVIEW_META_KEY, THEME_META_KEY, VIEW_CONTENT_KEY, VIEW_ID_META_KEY, type ComponentManifest, type Theme } from "@app-mcp/format";
import type { McpUiDisplayMode, McpUiHostContext, McpUiStyles } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { fieldsOf, partials, starterProps, type Field } from "./props.js";

/**
 * genui dev: a local MCP Apps host for one component. It stands in for the model (props,
 * optionally streamed), the SDK (render result with view id, workspace theme and preview flag)
 * and the company's MCP server (mock tools), and logs everything the component sends back.
 */

type Mode = "light" | "dark";
/**
 * Where the view's saved state goes, like on a real host: localStorage (Claude and most hosts),
 * ChatGPT's widget state (a `window.openai` shim the dev page injects, kept here per view id),
 * or nowhere (storage blocked, so the view keeps state in memory).
 */
type HostState = "browser" | "chatgpt" | "none";
const HOST_STATES: [HostState, string][] = [
  ["browser", "localStorage"],
  ["chatgpt", "ChatGPT widget state"],
  ["none", "None (memory)"],
];
interface Mock {
  mode: "data" | "error";
  data: string;
  error: string;
  delay: number;
}
interface Settings {
  props: Record<string, unknown>;
  stream: boolean;
  theme: Mode;
  hostStyles: boolean;
  width: number;
  workspace: { on: boolean; light: string; dark: string };
  preview: boolean;
  hostState: HostState;
  mocks: Record<string, Mock>;
}

// Roughly Claude-like host variables (same as the playground).
const HOST_VARS: Record<Mode, Record<string, string>> = {
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

const WIDTHS: [string, number][] = [
  ["Phone", 360],
  ["Chat", 640],
  ["Wide", 860],
];

// ── DOM helpers ────────────────────────────────────────────────────────────────

type Attrs = { [key: `on${string}`]: ((event: Event) => void) | undefined } & { [key: string]: unknown };
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el) Reflect.set(el, key, value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return el;
}

const input = (event: Event) => event.target as HTMLInputElement;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function select(values: string[], current: string, onchange: (value: string) => void, labels = values) {
  return h(
    "select",
    { onchange: (e) => onchange(input(e).value) },
    ...values.map((v, i) => h("option", { value: v, selected: v === current }, labels[i] ?? v)),
  );
}

// ── State ──────────────────────────────────────────────────────────────────────

const root = document.getElementById("app")!;
const viewUrl = root.dataset.viewUrl ?? "/?genui-view";
let manifest: ComponentManifest;
let manifestError: string | undefined;
let settings: Settings;
let propsTab: "form" | "json" = "form";

async function fetchManifest(): Promise<ComponentManifest | undefined> {
  try {
    const res = await fetch("/__genui/component.json");
    const body = (await res.json()) as ComponentManifest & { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    manifestError = undefined;
    return body;
  } catch (cause) {
    manifestError = cause instanceof Error ? cause.message : String(cause);
    return undefined;
  }
}

const storageKey = () => `genui-dev:${manifest.name}`;
const defaultMock = (tool: string): Mock => ({ mode: "data", data: '{\n  "ok": true\n}', error: `${tool} failed`, delay: 300 });

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey()) ?? "{}") as Partial<Settings>;
  } catch {
    saved = {};
  }
  return {
    props: saved.props ?? starterProps(manifest.props),
    stream: saved.stream ?? true,
    theme: saved.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    hostStyles: saved.hostStyles ?? true,
    width: saved.width ?? 640,
    workspace: saved.workspace ?? { on: false, light: "#2563eb", dark: "#60a5fa" },
    preview: saved.preview ?? false,
    hostState: saved.hostState ?? "browser",
    mocks: saved.mocks ?? {},
  };
}

function ensureMocks() {
  for (const tool of manifest.tools) settings.mocks[tool] ??= defaultMock(tool);
}

function save() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings just won't survive a reload.
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────────

const statusPill = h("span", { className: "pill" }, "live");
const nameEl = h("span", { className: "name" });
const propsSection = h("section");
const hostSection = h("section");
const toolsSection = h("section");
const bubble = h("p", { className: "bubble" });
const frame = h("div", { className: "frame" });
const chat = h("div", { id: "chat" }, bubble, frame);
const logList = h("div");

function layout() {
  root.replaceChildren(
    h("aside", {}, h("header", {}, h("b", {}, "genui dev"), nameEl, statusPill), propsSection, hostSection, toolsSection),
    h(
      "main",
      {},
      chat,
      h(
        "div",
        { id: "log" },
        h("div", { className: "bar" }, h("b", {}, "Host log"), h("button", { onclick: () => logList.replaceChildren() }, "Clear")),
        logList,
      ),
    ),
  );
}

type LogKind = "render" | "tool" | "model" | "message" | "state" | "info" | "warn";

function write(kind: LogKind, label: string, data?: unknown) {
  const text = data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data);
  const time = new Date().toLocaleTimeString([], { hour12: false });
  logList.prepend(h("div", { className: `entry ${kind}` }, h("time", {}, time), h("b", {}, label), h("pre", {}, text)));
  while (logList.childElementCount > 300) logList.lastElementChild?.remove();
}

function setLive(live: boolean) {
  statusPill.textContent = live ? "live" : "disconnected";
  statusPill.classList.toggle("off", !live);
}

// ── Props ──────────────────────────────────────────────────────────────────────

let renderTimer: ReturnType<typeof setTimeout> | undefined;

function propsChanged() {
  save();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void render(), 500);
}

function fieldControl(field: Field): HTMLElement {
  const value = settings.props[field.name];
  const error = h("p", { className: "error" });
  const set = (next: unknown) => {
    if (next === undefined) delete settings.props[field.name];
    else settings.props[field.name] = next;
    propsChanged();
  };

  let control: HTMLElement;
  switch (field.kind) {
    case "string":
      control = h("input", {
        type: "text",
        value: typeof value === "string" ? value : "",
        oninput: (e) => {
          const text = input(e).value;
          set(text === "" && !field.required ? undefined : text);
        },
      });
      break;
    case "number":
    case "integer":
      control = h("input", {
        type: "number",
        value: typeof value === "number" ? String(value) : "",
        min: field.min,
        max: field.max,
        step: field.kind === "integer" ? 1 : "any",
        oninput: (e) => {
          const raw = input(e).value;
          set(raw === "" ? undefined : Number(raw));
        },
      });
      break;
    case "boolean":
      control = field.required
        ? h("input", { type: "checkbox", checked: value === true, onchange: (e) => set(input(e).checked) })
        : select(["", "true", "false"], value === undefined ? "" : String(value), (v) => set(v === "" ? undefined : v === "true"), [
            "(unset)",
            "true",
            "false",
          ]);
      break;
    case "enum": {
      const options = field.options ?? [];
      const values = [...(field.required ? [] : [""]), ...options.map((o) => JSON.stringify(o))];
      const labels = [...(field.required ? [] : ["(unset)"]), ...options.map(String)];
      control = select(values, value === undefined ? "" : JSON.stringify(value), (v) => set(v === "" ? undefined : JSON.parse(v)), labels);
      break;
    }
    default:
      control = h("textarea", {
        value: value === undefined ? "" : JSON.stringify(value, null, 2),
        oninput: (e) => {
          const raw = input(e).value.trim();
          try {
            set(raw ? JSON.parse(raw) : undefined);
            error.textContent = "";
          } catch {
            error.textContent = "Invalid JSON";
          }
        },
      });
  }

  const hint = field.required ? field.kind : `${field.kind}, optional`;
  return h(
    "label",
    { className: "field" },
    h("span", {}, `${field.name} `, h("i", {}, hint)),
    control,
    field.description ? h("small", {}, field.description) : null,
    error,
  );
}

function propsJson(): HTMLElement {
  const error = h("p", { className: "error" });
  const editor = h("textarea", {
    className: "big",
    value: JSON.stringify(settings.props, null, 2),
    oninput: (e) => {
      try {
        const next: unknown = JSON.parse(input(e).value);
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Props must be a JSON object.");
        settings.props = next as Record<string, unknown>;
        error.textContent = "";
        propsChanged();
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
      }
    },
  });
  return h("div", {}, editor, error);
}

function renderPropsSection() {
  const fields = fieldsOf(manifest.props);
  const tab = (id: typeof propsTab, label: string) =>
    h(
      "button",
      {
        "aria-pressed": String(propsTab === id),
        onclick: () => {
          propsTab = id;
          renderPropsSection();
        },
      },
      label,
    );
  const body =
    propsTab === "json"
      ? propsJson()
      : fields.length
        ? h("div", {}, ...fields.map(fieldControl))
        : h("p", { className: "hint" }, "This component takes no props.");

  propsSection.replaceChildren(
    h("h2", {}, "Props", h("span", { className: "tabs" }, tab("form", "Form"), tab("json", "JSON"))),
    ...(manifestError ? [h("p", { className: "error" }, manifestError)] : []),
    body,
    h(
      "div",
      { className: "row" },
      h("button", { className: "primary", title: "New render with a new view id (⌘/Ctrl+Enter)", onclick: () => void render() }, "Render"),
      h(
        "button",
        {
          className: "secondary",
          title: "Same view id: state the component saved comes back",
          onclick: () => void render({ replay: true }),
        },
        "Replay",
      ),
      h(
        "label",
        { title: "Send the props in growing pieces first, like a model writing them" },
        h("input", {
          type: "checkbox",
          checked: settings.stream,
          onchange: (e) => {
            settings.stream = input(e).checked;
            save();
          },
        }),
        "Stream",
      ),
    ),
  );
}

// ── Host ───────────────────────────────────────────────────────────────────────

function renderHostSection() {
  const workspaceColor = (mode: Mode) =>
    h("input", {
      type: "color",
      value: settings.workspace[mode],
      title: `Primary in ${mode} mode`,
      onchange: (e) => {
        settings.workspace[mode] = input(e).value;
        save();
        if (settings.workspace.on) void render({ replay: true });
      },
    });

  hostSection.replaceChildren(
    h("h2", {}, "Host"),
    h(
      "div",
      { className: "row" },
      h(
        "label",
        {},
        "Theme ",
        select(["light", "dark"], settings.theme, (v) => {
          settings.theme = v as Mode;
          save();
          applyHost();
        }),
      ),
      h(
        "label",
        {},
        "Width ",
        select(
          WIDTHS.map(([, w]) => String(w)),
          String(settings.width),
          (v) => {
            settings.width = Number(v);
            save();
            applyHost();
          },
          WIDTHS.map(([name, w]) => `${name} ${w}px`),
        ),
      ),
    ),
    h(
      "div",
      { className: "row" },
      h(
        "label",
        { title: "Send the host's --color-* and --font-* variables" },
        h("input", {
          type: "checkbox",
          checked: settings.hostStyles,
          onchange: (e) => {
            settings.hostStyles = input(e).checked;
            save();
            applyHost();
          },
        }),
        "Host style variables",
      ),
    ),
    h(
      "div",
      { className: "row" },
      h(
        "label",
        { title: "Workspace theme, sent in the render result like the SDK does (--genui-primary)" },
        h("input", {
          type: "checkbox",
          checked: settings.workspace.on,
          onchange: (e) => {
            settings.workspace.on = input(e).checked;
            save();
            void render({ replay: true });
          },
        }),
        "Workspace primary",
      ),
      workspaceColor("light"),
      workspaceColor("dark"),
    ),
    h(
      "div",
      { className: "row" },
      h(
        "label",
        { title: "Render like the registry's admin preview: tools.call resolves as unavailable without calling" },
        h("input", {
          type: "checkbox",
          checked: settings.preview,
          onchange: (e) => {
            settings.preview = input(e).checked;
            save();
            void render({ replay: true });
          },
        }),
        "Registry preview",
      ),
    ),
    h(
      "div",
      { className: "row" },
      h(
        "label",
        { title: "Where the view's ctx.useState values are saved. Replay keeps the view id, so they come back." },
        "Saved state ",
        select(
          HOST_STATES.map(([value]) => value),
          settings.hostState,
          (v) => {
            settings.hostState = v as HostState;
            save();
            void render({ replay: true });
          },
          HOST_STATES.map(([, label]) => label),
        ),
      ),
      h("button", { className: "secondary", title: "Forget every view's saved state", onclick: clearSavedState }, "Clear"),
    ),
  );
}

// ── Saved state ────────────────────────────────────────────────────────────────

/** ChatGPT's widget state per view id: what the host stores with each message. */
const widgetStates = new Map<string, unknown>();

// The dev page's `window.openai` shim (genui:dev) reads and writes through this, same origin.
(window as { __genuiDev?: unknown }).__genuiDev = {
  widgetState: () => (viewId ? (widgetStates.get(viewId) ?? null) : null),
  setWidgetState(state: unknown) {
    if (!viewId) return;
    widgetStates.set(viewId, structuredClone(state));
    write("state", "→ widget state", state);
  },
};

// The view writes localStorage from its own window, so this one hears about it.
addEventListener("storage", ({ key, newValue }) => {
  if (!key?.startsWith("genui:") || key === "genui:probe" || newValue === null) return;
  try {
    write("state", "→ saved state", { key, ...(JSON.parse(newValue) as object) });
  } catch {
    write("state", "→ saved state", { key, value: newValue });
  }
});

function clearSavedState() {
  widgetStates.clear();
  for (const key of Object.keys(localStorage)) if (key.startsWith("genui:")) localStorage.removeItem(key);
  write("info", "saved state cleared");
}

// ── Mock tools ─────────────────────────────────────────────────────────────────

function toolControl(name: string): HTMLElement {
  const mock = settings.mocks[name]!;
  const body = h("div");
  const draw = () =>
    body.replaceChildren(
      mock.mode === "data"
        ? h("textarea", {
            value: mock.data,
            title: "JSON the tool returns (structuredContent)",
            oninput: (e) => {
              mock.data = input(e).value;
              save();
            },
          })
        : h("input", {
            type: "text",
            value: mock.error,
            title: "Error text the tool returns (isError)",
            oninput: (e) => {
              mock.error = input(e).value;
              save();
            },
          }),
    );
  draw();

  return h(
    "div",
    { className: "tool" },
    h(
      "div",
      { className: "row" },
      h("code", {}, name),
      select(
        ["data", "error"],
        mock.mode,
        (v) => {
          mock.mode = v as Mock["mode"];
          save();
          draw();
        },
        ["Returns data", "Returns an error"],
      ),
      h(
        "label",
        {},
        h("input", {
          type: "number",
          value: String(mock.delay),
          min: 0,
          step: 100,
          style: "width: 72px",
          oninput: (e) => {
            mock.delay = Number(input(e).value) || 0;
            save();
          },
        }),
        "ms",
      ),
    ),
    body,
  );
}

function renderToolsSection() {
  toolsSection.replaceChildren(
    h("h2", {}, "Mock tools"),
    ...(manifest.tools.length ? manifest.tools.map(toolControl) : [h("p", { className: "hint" }, "This component calls no tools.")]),
  );
}

async function callTool(name: string, args: Record<string, unknown>) {
  write("tool", `→ ${name}`, args);
  const mock = settings.mocks[name];
  const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
  if (!mock || !manifest.tools.includes(name)) {
    write("warn", `${name} is not declared`, "Add it to tools in defineComponent to mock it here.");
    return fail(`Unknown tool ${name}`);
  }
  await sleep(mock.delay);
  if (mock.mode === "error") {
    write("tool", `← ${name} error`, mock.error);
    return fail(mock.error);
  }
  let data: unknown;
  try {
    data = JSON.parse(mock.data || "null");
  } catch {
    write("warn", `mock ${name}`, "The mock response is not valid JSON.");
    return fail("Mock response is not valid JSON");
  }
  write("tool", `← ${name}`, data);
  const structured = data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {};
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], ...structured };
}

// ── Rendering the view ─────────────────────────────────────────────────────────

let bridge: AppBridge | undefined;
let initialized = false;
let viewId: string | undefined;
let displayMode: McpUiDisplayMode = "inline";
let renders = 0;

function hostContext(): McpUiHostContext {
  return {
    theme: settings.theme,
    platform: "web",
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    ...(settings.hostStyles ? { styles: { variables: HOST_VARS[settings.theme] as McpUiStyles } } : {}),
  };
}

function applyHost() {
  chat.classList.toggle("dark", settings.theme === "dark");
  frame.style.maxWidth = `${settings.width}px`;
  if (bridge && initialized) void Promise.resolve(bridge.sendHostContextChange(hostContext())).catch(() => {});
}

/** What the SDK returns from render_<name>: the same `_meta` contract as on a real server. */
function renderResult() {
  const theme: Theme | undefined = settings.workspace.on
    ? { light: { primary: settings.workspace.light }, dark: { primary: settings.workspace.dark } }
    : undefined;
  return {
    content: [{ type: "text" as const, text: `Showing ${manifest.title ?? manifest.name}.` }],
    structuredContent: { [VIEW_CONTENT_KEY]: { id: viewId } },
    _meta: {
      [VIEW_ID_META_KEY]: viewId,
      ...(settings.preview ? { [PREVIEW_META_KEY]: true } : {}),
      ...(theme ? { [THEME_META_KEY]: theme } : {}),
    },
  };
}

const texts = (content: { type: string; text?: string }[] | undefined) => {
  const list = (content ?? []).map((c) => c.text ?? c);
  return list.length === 1 ? list[0] : list;
};

async function render({ replay = false } = {}) {
  clearTimeout(renderTimer);
  const run = ++renders;
  if (bridge) {
    const old = bridge;
    bridge = undefined;
    await Promise.race([old.teardownResource({}).catch(() => {}), sleep(300)]);
    await old.close().catch(() => {});
  }
  if (run !== renders) return; // a newer render started meanwhile

  if (!replay || !viewId) viewId = crypto.randomUUID();
  initialized = false;
  displayMode = "inline";
  chat.classList.remove("fullscreen");
  const props = structuredClone(settings.props);
  const where = HOST_STATES.find(([value]) => value === settings.hostState)?.[1] ?? settings.hostState;
  bubble.textContent = `render_${manifest.name} · view ${viewId.slice(0, 8)}${replay ? " · replay" : ""} · state: ${where}`;

  const iframe = h("iframe", { title: manifest.title ?? manifest.name });
  // Same origin as the dev server so Vite can serve modules; real hosts also give each server its own origin.
  iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
  iframe.src = `${viewUrl}&genui-host=${settings.hostState}`;
  frame.replaceChildren(iframe);

  const next = new AppBridge(
    null,
    { name: "genui-dev", version: "0.1.0" },
    { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: { text: {} }, message: { text: {} } },
    { hostContext: hostContext() },
  );
  bridge = next;
  next.onsizechange = ({ height }) => {
    if (height && displayMode === "inline") iframe.style.height = `${height}px`;
  };
  next.oncalltool = (params) => callTool(params.name, params.arguments ?? {});
  next.onupdatemodelcontext = async (params) => {
    write("model", "→ model context", texts(params.content));
    return {};
  };
  next.onmessage = async (params) => {
    write("message", "→ chat message", texts(params.content));
    return {};
  };
  next.onopenlink = async ({ url }) => {
    write("info", "→ open link", url);
    return {};
  };
  next.onloggingmessage = ({ level, data }) => write(level === "error" ? "warn" : "info", `view log (${level})`, data);
  next.onrequestdisplaymode = async ({ mode }) => {
    displayMode = mode === "fullscreen" ? "fullscreen" : "inline";
    chat.classList.toggle("fullscreen", displayMode === "fullscreen");
    write("info", "→ display mode", displayMode);
    void Promise.resolve(next.sendHostContextChange(hostContext())).catch(() => {});
    return { mode: displayMode };
  };
  next.oninitialized = async () => {
    if (next !== bridge) return;
    initialized = true;
    write("render", replay ? "replay" : "render", { view: viewId, props });
    const current = () => next === bridge; // a newer render tears this one down mid-way
    try {
      if (settings.stream) {
        for (const partial of partials(props)) {
          if (!current()) return;
          await next.sendToolInputPartial({ arguments: partial });
          await sleep(60);
        }
      }
      if (!current()) return;
      await next.sendToolInput({ arguments: props });
      await sleep(120); // the server runs render_<name>
      if (current()) await next.sendToolResult(renderResult());
    } catch (cause) {
      if (current()) write("warn", "host error", String(cause));
    }
  };
  await next.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
}

// ── Live reload ────────────────────────────────────────────────────────────────

function listen() {
  const events = new EventSource("/__genui/events");
  events.onopen = () => setLive(true);
  events.onerror = () => setLive(false);
  events.addEventListener("reload", async (event) => {
    const { file } = JSON.parse((event as MessageEvent<string>).data) as { file: string };
    const next = await fetchManifest();
    if (next) {
      const changed = JSON.stringify([next.props, next.tools]) !== JSON.stringify([manifest.props, manifest.tools]);
      manifest = next;
      ensureMocks();
      nameEl.textContent = `${manifest.name}@${manifest.version}`;
      if (changed) renderToolsSection();
    }
    renderPropsSection();
    write("info", "reload", `${file} changed: replaying the same view`);
    void render({ replay: true });
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────

const first = await fetchManifest();
if (!first) {
  root.replaceChildren(
    h("pre", { className: "error", style: "padding: 16px" }, `genui dev: ${manifestError}\n\nFix it and save; the page reloads.`),
  );
  new EventSource("/__genui/events").addEventListener("reload", () => location.reload());
} else {
  manifest = first;
  settings = loadSettings();
  ensureMocks();
  layout();
  nameEl.textContent = `${manifest.name}@${manifest.version}`;
  renderPropsSection();
  renderHostSection();
  renderToolsSection();
  applyHost();
  listen();
  addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void render();
  });
  void render();
}
