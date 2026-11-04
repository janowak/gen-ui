import { viewBundles, type ViewBundle, type ViewName } from "@app-mcp/runtime";

export type { ViewName };
export const MANAGEMENT_VIEWS = ["manager", "theme", "workflows", "workspace", "members", "tokens", "connector", "instructions"] as const;
export type ManagementViewName = (typeof MANAGEMENT_VIEWS)[number];

/**
 * The HTML the registry serves. Each runtime loads it its own way: Node reads it from disk
 * (assets-node.ts), the Worker bundles it (worker.ts).
 */
export interface Assets {
  /** Single-file views from @app-mcp/ui. */
  views: Record<ViewName | ManagementViewName, string>;
  /** Sign-in and consent pages, built from web/ into dist-web/. */
  pages: Record<"sign-in" | "consent", string>;
}

const hashed = new WeakMap<Assets, Record<ViewName, ViewBundle>>();

/** The built-in form and chart views with their `ui://` URIs, hashed once per process. */
export function builtInViews(assets: Assets): Record<ViewName, ViewBundle> {
  let views = hashed.get(assets);
  if (!views) hashed.set(assets, (views = viewBundles(assets.views)));
  return views;
}
