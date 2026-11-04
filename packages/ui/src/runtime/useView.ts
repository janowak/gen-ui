import { PREVIEW_META_KEY, readViewId, THEME_META_KEY } from "@app-mcp/format";
import { pageViewStore } from "@app-mcp/kit/state";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useState } from "react";
import { applyTheme } from "./theme";

export interface RenderResult {
  isError: boolean;
  text: string;
  meta: Record<string, unknown>;
  structured: unknown;
  viewId: string | undefined;
}

export interface ViewState {
  app: App | null;
  connectError: Error | null;
  /** Latest tool arguments. While `streaming`, they are partial ("healed") JSON. */
  input: Record<string, unknown> | undefined;
  streaming: boolean;
  /** Result of the render tool: server-side validation + theme + preview flag. */
  result: RenderResult | undefined;
  /** The render id, once the result arrived: the key of this render's saved state, and an idempotency key for submits. */
  viewId: string | undefined;
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
      // Before connecting: the render id comes with the tool result, which the host sends once.
      pageViewStore().attach(created, name);
      created.onteardown = async () => {
        await pageViewStore().info.flush();
        return {};
      };
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
        setResult({
          isError: res.isError === true,
          text,
          meta: (res._meta ?? {}) as Record<string, unknown>,
          structured: res.structuredContent,
          viewId: readViewId(res),
        });
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

  return { app, connectError: error ?? null, input, streaming, result, viewId: result?.viewId, cancelled, hostContext };
}

/**
 * Whether the view may call tools: once the server accepted the render, and never in registry
 * previews (the tools live on the company's own server).
 */
export function toolsReady(result: RenderResult | undefined): boolean {
  return Boolean(result && !result.isError && result.meta[PREVIEW_META_KEY] !== true);
}
