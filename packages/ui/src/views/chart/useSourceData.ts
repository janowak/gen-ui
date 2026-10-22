import { getItems, rowsToSeries, type ChartSpec, type SeriesData } from "@genui/format";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState, type RefObject } from "react";
import { callTool } from "@/runtime/tools";

export interface SourceState {
  data: SeriesData | null;
  /** True during any fetch, including background refreshes that keep showing stale data. */
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
}

/** True while the element is on screen and the document is visible. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [intersecting, setIntersecting] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const el = ref.current;
    const observer = el ? new IntersectionObserver(([entry]) => setIntersecting(entry?.isIntersecting ?? true)) : null;
    if (el && observer) observer.observe(el);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [ref]);
  return intersecting && visible;
}

/**
 * Fetches chart rows through the source tool. Refreshes keep the previous data on screen
 * (stale-while-revalidate) and polling pauses while the chart is offscreen.
 */
export function useSourceData(
  app: App | null,
  spec: ChartSpec | undefined,
  enabled: boolean,
  containerRef: RefObject<HTMLElement | null>,
): SourceState {
  const [state, setState] = useState<SourceState>({ data: null, loading: false, error: null, updatedAt: null });
  const [tick, setTick] = useState(0);
  const onScreen = useOnScreen(containerRef);
  const specRef = useRef(spec);
  specRef.current = spec;
  const source = spec && "source" in spec.data ? spec.data.source : undefined;
  const sourceKey = JSON.stringify(source);

  useEffect(() => {
    const current = specRef.current;
    if (!app || !enabled || !current || !("source" in current.data)) return;
    const { toolName, params, itemsPath } = current.data.source;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    callTool(app, toolName, params ?? {}, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.isError) {
          setState((s) => ({ ...s, loading: false, error: outcome.text || "Could not load chart data" }));
        } else {
          const data = rowsToSeries(getItems(outcome.data, itemsPath), current);
          setState({ data, loading: false, error: null, updatedAt: new Date() });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [app, enabled, sourceKey, tick]);

  const refreshSeconds = spec?.refreshSeconds;
  useEffect(() => {
    if (!enabled || !refreshSeconds || !onScreen) return;
    const timer = setInterval(() => setTick((t) => t + 1), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, refreshSeconds, onScreen]);

  return state;
}
