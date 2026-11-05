import { createHash } from "node:crypto";

export type ViewName = "form" | "chart";

export interface UiDocument {
  html: string;
  _meta?: Record<string, unknown>;
}

export type UiBundle = string | UiDocument;
export const document = (value: UiBundle): UiDocument => (typeof value === "string" ? { html: value } : value);

export interface ViewBundle extends UiDocument {
  name: ViewName;
  html: string;
  /** Content hash; part of the `ui://` URI so hosts never serve a stale cached bundle. */
  hash: string;
  uri: string;
}

export const contentHash = (html: string) => createHash("sha256").update(html).digest("hex").slice(0, 16);

export function bundle(name: ViewName, value: UiBundle): ViewBundle {
  const doc = document(value);
  const hash = contentHash(doc._meta ? JSON.stringify(doc) : doc.html);
  return { name, ...doc, hash, uri: `ui://app-mcp/${name}/${hash}` };
}

/** The built-in form and chart views with their `ui://` URIs, from the HTML in @app-mcp/ui. */
export function viewBundles(html: Record<ViewName, UiBundle>): Record<ViewName, ViewBundle> {
  return { form: bundle("form", html.form), chart: bundle("chart", html.chart) };
}
