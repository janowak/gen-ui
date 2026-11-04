import { readViewId } from "@app-mcp/format";

/**
 * Where a view's state is kept:
 * - `host`: stored with the message by the host (ChatGPT's widget state), so it follows the user.
 * - `browser`: `localStorage`, this browser only.
 * - `memory`: this view only; gone when the host renders the message again.
 */
export type Persistence = "host" | "browser" | "memory";

/** What a backend keeps per render: every hook's value by key, and when it was last written. */
export interface Saved {
  values: Record<string, unknown>;
  at: number;
}

export interface StateBackend {
  readonly persistence: Persistence;
  /** Needs the render id. Host state is already scoped to the message, so it doesn't wait for one. */
  readonly keyed: boolean;
  load(key: string): Saved | undefined | Promise<Saved | undefined>;
  save(key: string, saved: Saved): void | Promise<void>;
}

export type StateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** A tool result, as far as the store reads it. */
type ToolResultParams = { structuredContent?: unknown; _meta?: unknown };

/** The part of an MCP Apps `App` the store listens to. Structural, so any copy of the ext-apps package fits. */
export interface AppEvents {
  addEventListener(event: "toolresult", handler: (params: ToolResultParams) => void): void;
  addEventListener(event: "toolcancelled", handler: (params: unknown) => void): void;
  removeEventListener(event: "toolresult", handler: (params: ToolResultParams) => void): void;
  removeEventListener(event: "toolcancelled", handler: (params: unknown) => void): void;
}

const PREFIX = "genui:";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Larger entries aren't saved: every replay would load them, and ChatGPT documents no limit for widget state. */
export const MAX_SAVED_BYTES = 64 * 1024;

function isSaved(value: unknown): value is Saved {
  const saved = value as Saved | null | undefined;
  return (
    typeof saved === "object" && saved !== null && typeof saved.at === "number" && typeof saved.values === "object" && saved.values !== null
  );
}

/** `localStorage` (or any `Storage`): one entry per render, `genui:<scope>:<render id>`. */
export function storageBackend(storage: StateStorage): StateBackend {
  return {
    persistence: "browser",
    keyed: true,
    load(key) {
      try {
        const raw = storage.getItem(key);
        const parsed: unknown = raw == null ? undefined : JSON.parse(raw);
        return isSaved(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    save(key, saved) {
      storage.setItem(key, JSON.stringify(saved));
    },
  };
}

/** Deletes genui entries not written for 30 days, and unreadable ones. Best effort: runs when a view opens. */
export function sweep(storage: StateStorage, now = Date.now()): void {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    let saved: unknown;
    try {
      saved = JSON.parse(storage.getItem(key) ?? "");
    } catch {
      saved = undefined;
    }
    if (!isSaved(saved) || now - saved.at > MAX_AGE_MS) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

/** The part of ChatGPT's `window.openai` the widget-state backend uses. */
export interface WidgetStateHost {
  widgetState?: Record<string, unknown> | null;
  setWidgetState(state: Record<string, unknown>): void | Promise<void>;
}

/**
 * ChatGPT's widget state, stored with the message. Kept under `privateContent`, which the model
 * doesn't see, and merged so a component's own `window.openai` state survives.
 */
export function widgetStateBackend(host: WidgetStateHost): StateBackend {
  const current = () => host.widgetState ?? {};
  const privateContent = () => {
    const value = current().privateContent;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  };
  return {
    persistence: "host",
    keyed: false,
    load() {
      const saved = privateContent().genui;
      return isSaved(saved) ? saved : undefined;
    },
    save(_key, saved) {
      return host.setWidgetState({ ...current(), privateContent: { ...privateContent(), genui: saved } });
    },
  };
}

export const memoryBackend: StateBackend = { persistence: "memory", keyed: false, load: () => undefined, save: () => {} };

/** localStorage where the host's sandbox allows it. Opaque-origin iframes throw on access. */
function browserStorage(): StateStorage | undefined {
  try {
    const storage = globalThis.localStorage;
    storage.setItem(`${PREFIX}probe`, "1");
    storage.removeItem(`${PREFIX}probe`);
    return storage;
  } catch {
    return undefined;
  }
}

/** Host state where the host has it (ChatGPT), else localStorage, else memory. */
export function defaultBackend(): StateBackend {
  const openai = (globalThis as { openai?: Partial<WidgetStateHost> }).openai;
  if (typeof openai?.setWidgetState === "function") return widgetStateBackend(openai as WidgetStateHost);
  const storage = browserStorage();
  if (!storage) return memoryBackend;
  sweep(storage);
  return storageBackend(storage);
}

/** What a state hook reports next to its value. */
export interface StateInfo {
  /** False until saved state is loaded: at once with host state (ChatGPT), with the render result elsewhere. */
  readonly restored: boolean;
  readonly persistence: Persistence;
  /** Writes pending changes now. Await it before a side effect that must not repeat, like a submit. */
  flush(): Promise<void>;
}

export type SetState<T> = (next: T | ((prev: T) => T)) => void;

/**
 * One view's state: every hook's value by key, saved per render. Values set before saved state
 * is loaded win over it, and are saved once it is.
 */
export interface ViewStore {
  readonly info: StateInfo;
  /** The render id, once the render result arrived. */
  readonly viewId: string | undefined;
  /** Bumps on every change, for `useSyncExternalStore`. */
  readonly version: number;
  has(key: string): boolean;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
  /** Binds the store to a view's `App`, before it connects: the render id comes with the tool result, which the host sends once. */
  attach(app: AppEvents, scope: string): void;
}

export interface ViewStoreOptions {
  /** Where state is saved. Defaults to `defaultBackend()`. */
  backend?: StateBackend;
  /** Delay before a change is written. Default 300 ms. */
  debounceMs?: number;
}

export function createViewStore({ backend = defaultBackend(), debounceMs = 300 }: ViewStoreOptions = {}): ViewStore {
  const values = new Map<string, unknown>();
  /** Keys set before saved state was loaded: they win over it. */
  const early = new Set<string>();
  const listeners = new Set<() => void>();
  let restored = false;
  let loading = false;
  let scope = "view";
  let viewId: string | undefined;
  /** Where writes go, once known: the entry key for keyed backends, and "memory" when there's nowhere to save. */
  let target: string | undefined;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  /** Writes run one after another; this settles when the last one has. */
  let writing: Promise<void> = Promise.resolve();
  let detach = () => {};
  let warned = false;

  function changed() {
    version++;
    // A copy, so a listener that unsubscribes while we notify can't change this loop.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) listener();
  }

  function write(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const key = target;
    if (!dirty || !key || key === "memory") return writing;
    dirty = false;
    const saved: Saved = { values: Object.fromEntries(values), at: Date.now() };
    if (JSON.stringify(saved).length > MAX_SAVED_BYTES) {
      if (!warned) console.warn(`[genui] view state is over ${MAX_SAVED_BYTES} bytes, so it isn't saved. Keep drafts small.`);
      warned = true;
      return writing;
    }
    writing = writing
      .then(() => backend.save(key, saved))
      .catch((error: unknown) =>
        console.warn(`[genui] could not save view state: ${error instanceof Error ? error.message : String(error)}`),
      );
    return writing;
  }

  function schedule() {
    dirty = true;
    if (!restored || !target) return; // saved once loading finishes
    clearTimeout(timer);
    timer = setTimeout(() => void write(), debounceMs);
  }

  async function load(key: string) {
    if (loading) return;
    loading = true;
    let saved: Saved | undefined;
    try {
      saved = await backend.load(key);
    } catch {
      saved = undefined;
    }
    for (const [name, value] of Object.entries(saved?.values ?? {})) if (!early.has(name)) values.set(name, value);
    target = key;
    restored = true;
    if (dirty) await write();
    changed();
  }

  /** No render id, or a failed or cancelled render: state stays in memory. */
  function unsaved() {
    if (restored) return;
    target = "memory";
    restored = true;
    changed();
  }

  const info: StateInfo = {
    get restored() {
      return restored;
    },
    get persistence() {
      return target === "memory" ? "memory" : backend.persistence;
    },
    flush: write,
  };

  // Host state is scoped to the message already: load it before anything renders.
  if (!backend.keyed) void load(PREFIX.slice(0, -1));

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", () => void write());
    globalThis.addEventListener("visibilitychange", () => {
      if (globalThis.document?.visibilityState === "hidden") void write();
    });
  }

  return {
    info,
    get viewId() {
      return viewId;
    },
    get version() {
      return version;
    },
    has: (key) => values.has(key),
    get: (key) => values.get(key),
    set(key, value) {
      values.set(key, value);
      if (!restored) early.add(key);
      schedule();
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(app, name) {
      detach();
      scope = name;
      const onResult = (result: ToolResultParams) => {
        const id = readViewId(result);
        if (id && id !== viewId) {
          viewId = id;
          changed();
        }
        if (!backend.keyed) return;
        if (id) void load(`${PREFIX}${scope}:${id}`);
        else unsaved();
      };
      const onCancelled = () => {
        if (backend.keyed) unsaved();
      };
      app.addEventListener("toolresult", onResult);
      app.addEventListener("toolcancelled", onCancelled);
      detach = () => {
        app.removeEventListener("toolresult", onResult);
        app.removeEventListener("toolcancelled", onCancelled);
      };
    },
  };
}

let page: ViewStore | undefined;

/** The store for this page's view (one view per iframe), created on first use. */
export function pageViewStore(): ViewStore {
  return (page ??= createViewStore());
}

/** Reads a hook's value: the saved or set value, else `initial()`. */
export function valueOf<T>(store: ViewStore, key: string, initial: () => T): T {
  return store.has(key) ? (store.get(key) as T) : initial();
}

/** A setter for one key, taking a value or an update from the previous one. */
export function setterOf<T>(store: ViewStore, key: string, initial: () => T): SetState<T> {
  return (next) => {
    const value = typeof next === "function" ? (next as (prev: T) => T)(valueOf(store, key, initial)) : next;
    store.set(key, value);
  };
}
