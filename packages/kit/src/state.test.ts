import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createViewStore,
  defaultBackend,
  MAX_SAVED_BYTES,
  setterOf,
  storageBackend,
  sweep,
  widgetStateBackend,
  type AppEvents,
  type StateStorage,
  type WidgetStateHost,
} from "./state.js";

function memoryStorage(entries: Record<string, string> = {}): StateStorage {
  const items = new Map(Object.entries(entries));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
}

/** Just enough of an `App` for the store: tool result and cancel listeners. */
function fakeApp() {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const app = {
    addEventListener: (event: string, handler: (params: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeEventListener: (event: string, handler: (params: unknown) => void) => listeners.get(event)?.delete(handler),
  };
  const emit = (event: string, params: unknown) => listeners.get(event)?.forEach((handler) => handler(params));
  return { app: app as AppEvents, emit };
}

const rendered = (id: string) => ({ content: [], structuredContent: { genui: { id } } });
const saved = (values: Record<string, unknown>, at = Date.now()) => JSON.stringify({ values, at });
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => vi.unstubAllGlobals());

describe("view store", () => {
  it("restores host state at once, and saves it privately without dropping the component's own state", async () => {
    const host: WidgetStateHost = {
      widgetState: { modelContent: "Rated 3/5", privateContent: { mine: true, genui: { values: { state: 3 }, at: 1 } } },
      setWidgetState: vi.fn((state) => void (host.widgetState = state)),
    };
    const store = createViewStore({ backend: widgetStateBackend(host) });
    await vi.waitFor(() => expect(store.info.restored).toBe(true));
    expect(store.get("state")).toBe(3);
    expect(store.info.persistence).toBe("host");

    store.set("state", 5);
    await store.info.flush();
    expect(host.widgetState).toEqual({ modelContent: "Rated 3/5", privateContent: { mine: true, genui: { values: { state: 5 }, at: expect.any(Number) } } });
  });

  it("waits for the render id in the browser, and a value set before the restore wins and is saved with it", async () => {
    const storage = memoryStorage({ "genui:form:v1": saved({ a: 1, b: 2 }) });
    const store = createViewStore({ backend: storageBackend(storage), debounceMs: 0 });
    const { app, emit } = fakeApp();
    store.attach(app, "form");

    store.set("a", 9);
    expect(store.info.restored).toBe(false);
    emit("toolresult", rendered("v1"));
    await vi.waitFor(() => expect(store.info.restored).toBe(true));
    expect(store.viewId).toBe("v1");
    expect([store.get("a"), store.get("b")]).toEqual([9, 2]);
    expect(JSON.parse(storage.getItem("genui:form:v1")!).values).toEqual({ a: 9, b: 2 });
  });

  it("debounces writes, and flush writes at once", async () => {
    const storage = memoryStorage();
    const store = createViewStore({ backend: storageBackend(storage), debounceMs: 60_000 });
    const { app, emit } = fakeApp();
    store.attach(app, "form");
    emit("toolresult", rendered("v1"));
    await vi.waitFor(() => expect(store.info.restored).toBe(true));

    store.set("state", "draft");
    expect(storage.getItem("genui:form:v1")).toBeNull();
    await store.info.flush();
    expect(JSON.parse(storage.getItem("genui:form:v1")!).values).toEqual({ state: "draft" });
  });

  it("keeps state in memory when the render has no id or is cancelled", async () => {
    for (const end of [(emit: (event: string, params: unknown) => void) => emit("toolresult", { content: [] }), (emit: (event: string, params: unknown) => void) => emit("toolcancelled", {})]) {
      const storage = memoryStorage();
      const store = createViewStore({ backend: storageBackend(storage), debounceMs: 0 });
      const { app, emit } = fakeApp();
      store.attach(app, "form");
      end(emit);
      expect(store.info).toMatchObject({ restored: true, persistence: "memory" });
      store.set("state", 1);
      await store.info.flush();
      expect(storage.length).toBe(0);
      expect(store.get("state")).toBe(1);
    }
  });

  it("doesn't save state over the size cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = memoryStorage();
    const store = createViewStore({ backend: storageBackend(storage) });
    const { app, emit } = fakeApp();
    store.attach(app, "form");
    emit("toolresult", rendered("v1"));
    await vi.waitFor(() => expect(store.info.restored).toBe(true));

    store.set("state", "x".repeat(MAX_SAVED_BYTES));
    await store.info.flush();
    expect(storage.getItem("genui:form:v1")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("setters take a value or an update from the previous one, starting from the initial value", () => {
    const store = createViewStore({ backend: storageBackend(memoryStorage()) });
    const set = setterOf(store, "count", () => 10);
    set((n) => n + 1);
    set((n) => n * 2);
    expect(store.get("count")).toBe(22);
  });
});

describe("backends", () => {
  it("picks ChatGPT's widget state, then localStorage, then memory", () => {
    vi.stubGlobal("openai", { widgetState: null, setWidgetState: () => {} });
    expect(defaultBackend().persistence).toBe("host");
    vi.unstubAllGlobals();

    vi.stubGlobal("localStorage", memoryStorage());
    expect(defaultBackend().persistence).toBe("browser");
    vi.unstubAllGlobals();

    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(defaultBackend().persistence).toBe("memory");
  });

  it("sweeps genui entries not written for 30 days, and unreadable ones", () => {
    const now = Date.now();
    const storage = memoryStorage({
      "genui:form:old": saved({}, now - 31 * DAY),
      "genui:form:new": saved({}, now - 2 * DAY),
      "genui:form:broken": "{",
      "other:key": "kept",
    });
    sweep(storage, now);
    expect([...Array(storage.length).keys()].map((i) => storage.key(i))).toEqual(["genui:form:new", "other:key"]);
  });
});
