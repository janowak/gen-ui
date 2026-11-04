import { PREVIEW_META_KEY, Theme, THEME_META_KEY } from "@app-mcp/format";
import type { App, McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import type { ComponentDefinition } from "./define.js";
import { pageViewStore, setterOf, valueOf, type SetState, type StateInfo, type ViewStore } from "./state.js";
import { readToolResult, unavailable, type ToolOutcome } from "./tools.js";

/**
 * - `waiting`: nothing from the host yet.
 * - `streaming`: the model is still writing the props; read `partial`.
 * - `ready`: `props` are complete and valid.
 * - `error`: invalid props, or the server rejected the render; read `error`.
 * - `cancelled`: the host cancelled the tool call.
 */
export type Status = "waiting" | "streaming" | "ready" | "error" | "cancelled";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface ComponentTools<T extends string> {
  /**
   * Resolves once the render result arrived: whether tools can be called. False in registry previews
   * (the tools live on the company's own server) and after a failed or cancelled render.
   */
  available(name: T): Promise<boolean>;
  /**
   * Calls a tool on the component's MCP server, once the render result arrived. Where tools can't be
   * called (see `available`), resolves as `{ ok: false, unavailable: true }` without calling.
   * Rejects only when `signal` aborts.
   */
  call(name: T, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolOutcome>;
}

export interface ModelBridge {
  /** Adds context the model reads on its next turn, without posting anything. False if the host refused. */
  update(text: string): Promise<boolean>;
  /** Posts a message in the chat as the user, so the model replies. False if the host refused. */
  send(text: string): Promise<boolean>;
}

export interface Display {
  readonly mode: McpUiDisplayMode;
  /** Whether the host offers this mode. */
  can(mode: McpUiDisplayMode): boolean;
  /** Asks the host to switch. Resolves with the mode the host is in afterwards. */
  request(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
}

/** What a component sees. One live object: read it again on every render. */
export interface ComponentContext<P, T extends string> {
  readonly status: Status;
  /** Complete, validated props. Set once `status` is "ready". */
  readonly props: P | undefined;
  /**
   * Latest arguments, possibly incomplete while streaming ("healed" JSON: the last item may be cut
   * off). For previews only; never act on it.
   */
  readonly partial: DeepPartial<P> | undefined;
  /** Why `status` is "error". */
  readonly error: string | undefined;
  /** The host's color scheme. */
  readonly theme: "light" | "dark";
  readonly tools: ComponentTools<T>;
  readonly model: ModelBridge;
  /**
   * State kept per render, like React's `useState`: a re-rendered message comes back as the user
   * left it. Call it in `render`, which runs again on every change. `key` tells several states in
   * one view apart. Where it's kept (host, browser, memory) is picked per host.
   */
  useState<S>(initial: S | (() => S), key?: string): [S, SetState<S>, StateInfo];
  /** The render id, once the render result arrived. Pass it to submit tools as an idempotency key. */
  readonly viewId: string | undefined;
  readonly display: Display;
  /** Escape hatch: the underlying MCP Apps `App`. */
  readonly app: App;
}

export type ContextOf<C> = C extends ComponentDefinition<infer P, infer T> ? ComponentContext<z.output<P>, T> : never;

export interface Runtime<P, T extends string> {
  context: ComponentContext<P, T>;
  /** Workspace theme from the latest render result. */
  workspaceTheme(): Theme | undefined;
  /** Puts the component in the error state, e.g. when connecting to the host failed. */
  fail(message: string): void;
}

export interface RuntimeOptions {
  /** Per-render state. Defaults to the page's store: host state (ChatGPT), else localStorage, else memory. */
  state?: ViewStore;
}

/**
 * Wires a component to an MCP Apps `App` (before it connects). Holds everything the host sends
 * and calls `onChange` whenever the context changed.
 */
export function createRuntime<P extends z.ZodObject, T extends string>(
  app: App,
  component: ComponentDefinition<P, T>,
  onChange: () => void,
  options: RuntimeOptions = {},
): Runtime<z.output<P>, T> {
  let status: Status = "waiting";
  let props: z.output<P> | undefined;
  let partial: unknown;
  let error: string | undefined;
  let workspace: Theme | undefined;
  /** Why this render can't call tools, if it can't. */
  let blocked: string | undefined;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const teardown = new AbortController();
  const store = options.state ?? pageViewStore();
  store.attach(app, component.name);
  store.subscribe(onChange);

  const model: ModelBridge = {
    async update(text) {
      try {
        await app.updateModelContext({ content: [{ type: "text", text }] });
        return true;
      } catch {
        return false;
      }
    },
    async send(text) {
      try {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        return result.isError !== true;
      } catch {
        return false;
      }
    },
  };

  const tools: ComponentTools<T> = {
    async available() {
      await settled;
      return blocked === undefined;
    },
    async call(name, args = {}, { signal } = {}) {
      if (!(await tools.available(name))) return unavailable(name, blocked!);
      const combined = signal ? AbortSignal.any([signal, teardown.signal]) : teardown.signal;
      try {
        return readToolResult(name, await app.callServerTool({ name, arguments: args }, { signal: combined }));
      } catch (cause) {
        if (combined.aborted) throw cause;
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause), unavailable: false, data: undefined, text: "" };
      }
    },
  };

  const display: Display = {
    get mode() {
      return app.getHostContext()?.displayMode ?? "inline";
    },
    can(mode) {
      return app.getHostContext()?.availableDisplayModes?.includes(mode) ?? mode === "inline";
    },
    async request(mode) {
      if (!display.can(mode)) return display.mode;
      try {
        return (await app.requestDisplayMode({ mode })).mode;
      } catch {
        return display.mode;
      }
    },
  };

  const context: ComponentContext<z.output<P>, T> = {
    get status() {
      return status;
    },
    get props() {
      return props;
    },
    get partial() {
      return partial as DeepPartial<z.output<P>> | undefined;
    },
    get error() {
      return error;
    },
    get theme() {
      return app.getHostContext()?.theme === "dark" ? "dark" : "light";
    },
    tools,
    model,
    useState<S>(initial: S | (() => S), key = "state"): [S, SetState<S>, StateInfo] {
      const first = () => (typeof initial === "function" ? (initial as () => S)() : initial);
      return [valueOf(store, key, first), setterOf(store, key, first), store.info];
    },
    get viewId() {
      return store.viewId;
    },
    display,
    app,
  };

  app.ontoolinputpartial = ({ arguments: args }) => {
    if (status !== "waiting" && status !== "streaming") return;
    partial = args;
    status = "streaming";
    onChange();
  };

  app.ontoolinput = ({ arguments: args }) => {
    partial = args;
    const parsed = component.props.safeParse(args ?? {});
    if (parsed.success) {
      props = parsed.data;
      status = "ready";
      error = undefined;
    } else {
      status = "error";
      error = `Invalid props for ${component.name}:\n${z.prettifyError(parsed.error)}`;
      void model.update(`${error}\nFix the arguments and call render_${component.name} again.`);
    }
    onChange();
  };

  app.ontoolresult = (result) => {
    const meta = (result._meta ?? {}) as Record<string, unknown>;
    const theme = Theme.safeParse(meta[THEME_META_KEY]);
    workspace = theme.success ? theme.data : undefined;
    if (result.isError === true && status !== "error") {
      status = "error";
      error = readToolResult(`render_${component.name}`, result).text || "The server could not render this component.";
    }
    blocked = meta[PREVIEW_META_KEY] === true ? "Tools don't run in previews." : result.isError === true ? "The render failed." : undefined;
    settle();
    onChange();
  };

  app.ontoolcancelled = () => {
    status = "cancelled";
    blocked = "The render was cancelled.";
    settle();
    onChange();
  };

  app.onhostcontextchanged = () => onChange();

  app.onteardown = async () => {
    teardown.abort();
    await store.info.flush();
    return {};
  };

  return {
    context,
    workspaceTheme: () => workspace,
    fail(message) {
      status = "error";
      error = message;
      onChange();
    },
  };
}
