import { useMemo, useRef, useSyncExternalStore } from "react";
import { pageViewStore, setterOf, valueOf, type SetState, type StateInfo } from "./state.js";

/**
 * `useState` kept per render: a re-rendered message comes back as the user left it. Where it's
 * kept (host state, localStorage, memory) and under which render id is worked out underneath, by
 * the store the view attached to its `App` (`mount` from `@app-mcp/kit`, or `pageViewStore().attach`).
 * `key` tells several states in one view apart. Like useState, `initial` is read once.
 */
export function useViewState<T>(initial: T | (() => T), key = "state"): [T, SetState<T>, StateInfo] {
  const store = pageViewStore();
  useSyncExternalStore(store.subscribe, () => store.version);
  const first = useRef<{ value: T }>(undefined);
  const initialRef = useRef(initial);
  const initialValue = useMemo(() => () => (first.current ??= { value: unwrap(initialRef.current) }).value, []);
  const set = useMemo(() => setterOf(store, key, initialValue), [store, key, initialValue]);
  return [valueOf(store, key, initialValue), set, store.info];
}

function unwrap<T>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}
