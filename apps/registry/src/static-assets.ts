import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { UiDocument } from "@app-mcp/runtime";

export interface StaticAssetStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | undefined>;
}

export interface StaticHosting {
  /** Public directory URL. Must remain available for previously published versions. */
  baseURL: string;
  store: StaticAssetStore;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Move executable inline scripts and styles to immutable objects without changing their bytes. */
export async function externalize(html: string, hosting: StaticHosting): Promise<UiDocument> {
  const base = new URL(hosting.baseURL.endsWith("/") ? hosting.baseURL : `${hosting.baseURL}/`);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("Static asset URL must be an http(s) directory URL without credentials, query or fragment");
  const edits: { start: number; end: number; text: string }[] = [];
  const uploads = new Map<string, { body: Uint8Array; type: string }>();
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node) {
      const loc = node.sourceCodeLocation;
      const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
      const type = (attr("type") ?? "").trim().toLowerCase();
      const script =
        node.tagName === "script" &&
        !node.attrs.some((a) => a.name === "src") &&
        ["", "module", "text/javascript", "application/javascript"].includes(type);
      const style = node.tagName === "style" && ["", "text/css"].includes(type);
      if ((script || style) && loc?.startTag && loc.endTag) {
        const source = html.slice(loc.startTag.endOffset, loc.endTag.startOffset);
        if (source.trim()) {
          const key = `${digest(source)}.${script ? "js" : "css"}`;
          const url = escape(new URL(key, base).href);
          const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
          uploads.set(key, {
            body: new TextEncoder().encode(source),
            type: script ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
          });
          let replacement: string;
          if (script) {
            // Classic external scripts remain parser blocking; module scripts retain module semantics.
            const attrs = node.attrs
              .filter((a) => !["integrity", "crossorigin"].includes(a.name) && (type === "module" || !["async", "defer"].includes(a.name)))
              .map((a) => ` ${a.name}="${escape(a.value)}"`)
              .join("");
            replacement = `<script${attrs} src="${url}" crossorigin="anonymous" integrity="${integrity}"></script>`;
          } else {
            const attrs = node.attrs
              .filter((a) => ["media", "title", "nonce"].includes(a.name))
              .map((a) => ` ${a.name}="${escape(a.value)}"`)
              .join("");
            replacement = `<link rel="stylesheet" href="${url}" crossorigin="anonymous" integrity="${integrity}"${attrs}>`;
          }
          edits.push({ start: loc.startOffset, end: loc.endOffset, text: replacement });
        }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html, { sourceCodeLocationInfo: true }));
  // Complete every object write before a caller stores the shell or moves an environment pointer.
  for (const [key, asset] of uploads) await hosting.store.put(key, asset.body, asset.type);
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return { html, ...(uploads.size ? { _meta: { ui: { csp: { resourceDomains: [base.origin] } } } } : {}) };
}

export function assetHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  };
}
