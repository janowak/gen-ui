import { toOptions, type Option, type ResourceSource } from "@app-mcp/format";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState } from "react";
import { callTool } from "@/runtime/tools";

const DEBOUNCE_MS = 250;

export interface OptionsState {
  options: Option[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Loads select options from a tool. Search-as-you-type is debounced and stale requests are aborted.
 * Without `searchParam`, options load once and are filtered client-side by the caller.
 */
export function useOptions(app: App | null, source: ResourceSource, query: string, enabled: boolean): OptionsState {
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sourceKey = JSON.stringify(source);
  const searchKey = source.searchParam ? query : "";
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!app || !enabled) return;
    const controller = new AbortController();
    const { toolName, params, searchParam } = sourceRef.current;
    // Show loading right away, not after the debounce, so typing gives immediate feedback.
    setLoading(true);
    const timer = setTimeout(
      async () => {
        setError(null);
        const args = { ...params, ...(searchParam && searchKey ? { [searchParam]: searchKey } : {}) };
        try {
          const outcome = await callTool(app, toolName, args, controller.signal);
          if (controller.signal.aborted) return;
          if (outcome.isError) {
            setError(outcome.text || "Could not load options");
            setOptions([]);
          } else {
            setOptions(toOptions(outcome.data, sourceRef.current));
          }
        } catch {
          // Aborted: a newer request owns the state.
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      searchKey ? DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [app, enabled, sourceKey, searchKey, attempt]);

  return { options, loading, error, retry: () => setAttempt((a) => a + 1) };
}
