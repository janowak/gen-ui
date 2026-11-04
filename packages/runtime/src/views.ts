import { createHash } from "node:crypto";

export type ViewName = "form" | "chart";

export interface ViewBundle {
  name: ViewName;
  html: string;
  /** Content hash; part of the `ui://` URI so hosts never serve a stale cached bundle. */
  hash: string;
  uri: string;
}

export const contentHash = (html: string) => createHash("sha256").update(html).digest("hex").slice(0, 16);

export function bundle(name: ViewName, html: string): ViewBundle {
  const hash = contentHash(html);
  return { name, html, hash, uri: `ui://app-mcp/${name}/${hash}` };
}

/** The built-in form and chart views with their `ui://` URIs, from the HTML in @app-mcp/ui. */
export function viewBundles(html: Record<ViewName, string>): Record<ViewName, ViewBundle> {
  return { form: bundle("form", html.form), chart: bundle("chart", html.chart) };
}
