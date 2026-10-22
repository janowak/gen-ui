export type StateStorage = Pick<Storage, "getItem" | "setItem">;

export interface ViewState {
  /** The value saved for this render, if any. */
  get<V = unknown>(): V | undefined;
  /** Saves a JSON value for this render. A re-rendered message (same view id) gets it back. */
  set(value: unknown): void;
}

/** localStorage where the host's sandbox allows it. Opaque-origin iframes throw on access. */
function browserStorage(): StateStorage | undefined {
  try {
    const storage = window.localStorage;
    storage.setItem("genui:probe", "1");
    return storage;
  } catch {
    return undefined;
  }
}

/**
 * Per-render state, keyed by the view id the SDK puts in the render result. Values set before
 * the id arrives are kept in memory and saved once it does.
 */
export function createViewState(scope: string, onChange: () => void, storage: StateStorage | undefined = browserStorage()) {
  let key: string | undefined;
  let value: unknown;
  let touched = false;

  function save() {
    if (!key || !storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota or serialization errors: keep the in-memory value.
    }
  }

  const state: ViewState = {
    get: <V>() => value as V | undefined,
    set(next) {
      value = next;
      touched = true;
      save();
      onChange();
    },
  };

  function load(viewId: string) {
    key = `genui:${scope}:${viewId}`;
    if (touched) return save();
    try {
      const raw = storage?.getItem(key);
      if (raw != null) value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }

  return { state, load };
}
