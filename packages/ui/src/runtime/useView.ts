import { THEME_META_KEY } from "@genui/format";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useState } from "react";
import { applyTheme } from "./theme";

/** Key under which the SDK lists the tools this view may call (validated server-side). */
export const ALLOWED_TOOLS_META_KEY = "genui/allowedTools";

export interface RenderResult {
  isError: boolean;
  text: string;
  meta: Record<string, unknown>;
  structured: unknown;
}

export interface ViewState {
  app: App | null;
  connectError: Error | null;
  /** Latest tool arguments. While `streaming`, they are partial ("healed") JSON. */
  input: Record<string, unknown> | undefined;
  streaming: boolean;
  /** Result of the render tool: server-side validation + theme + allowed tools. */
  result: RenderResult | undefined;
  cancelled: boolean;
  hostContext: McpUiHostContext | undefined;
}

export function useView(name: string): ViewState {
  const [input, setInput] = useState<Record<string, unknown>>();
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState<RenderResult>();
  const [cancelled, setCancelled] = useState(false);
  const [hostContext, setHostContext] = useState<McpUiHostContext>();

  const { app, error } = useApp({
    appInfo: { name: `genui-${name}`, version: "0.1.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolinputpartial = (params) => {
        setInput(params.arguments);
        setStreaming(true);
      };
      created.ontoolinput = (params) => {
        setInput(params.arguments);
        setStreaming(false);
      };
      created.ontoolresult = (res) => {
        const text = (res.content ?? [])
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n");
        setResult({ isError: res.isError === true, text, meta: (res._meta ?? {}) as Record<string, unknown>, structured: res.structuredContent });
      };
      created.ontoolcancelled = () => setCancelled(true);
      created.onhostcontextchanged = (ctx) => setHostContext((prev) => ({ ...prev, ...ctx }));
    },
  });

  useHostStyles(app, app?.getHostContext());

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  const workspace = result?.meta[THEME_META_KEY];
  const mode = hostContext?.theme === "dark" ? "dark" : "light";
  const hostVariables = hostContext?.styles?.variables;
  useEffect(() => applyTheme({ mode, hostVariables, workspace }), [mode, hostVariables, workspace]);

  return { app, connectError: error ?? null, input, streaming, result, cancelled, hostContext };
}

/** Tools the server approved for this view. Empty until the render result arrives. */
export function allowedTools(result: RenderResult | undefined): Set<string> {
  const list = result?.meta[ALLOWED_TOOLS_META_KEY];
  return new Set(Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : []);
}
