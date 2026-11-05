import { viewBundles, type UiDocument, type ViewBundle, type ViewName } from "@app-mcp/runtime";

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
  /** Immutable CSP metadata for views externalized by the registry. */
  viewMetadata?: Partial<Record<ViewName | ManagementViewName, UiDocument["_meta"]>>;
  /** Sign-in, consent and the web console, built from web/ into dist-web/. */
  pages: Record<"sign-in" | "consent" | "manage", string>;
}

const hashed = new WeakMap<Assets, Record<ViewName, ViewBundle>>();

/** The built-in form and chart views with their `ui://` URIs, hashed once per process. */
export function builtInViews(assets: Assets): Record<ViewName, ViewBundle> {
  let views = hashed.get(assets);
  if (!views)
    hashed.set(
      assets,
      (views = viewBundles({
        form: { html: assets.views.form, _meta: assets.viewMetadata?.form },
        chart: { html: assets.views.chart, _meta: assets.viewMetadata?.chart },
      })),
    );
  return views;
}

/** Prepare every chat view before serving requests; website/auth pages remain ordinary pages. */
export async function hostViews(assets: Assets, hosting: import("./static-assets.js").StaticHosting): Promise<Assets> {
  const { externalize } = await import("./static-assets.js");
  const hosted: Assets = { ...assets, views: { ...assets.views }, viewMetadata: {} };
  for (const name of Object.keys(assets.views) as (ViewName | ManagementViewName)[]) {
    const resource = await externalize(assets.views[name], hosting);
    hosted.views[name] = resource.html;
    hosted.viewMetadata![name] = resource._meta;
  }
  return hosted;
}
