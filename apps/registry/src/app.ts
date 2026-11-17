import { assetHeaders, type StaticHosting } from "./static-assets.js";
import { MAX_PUBLISH_BYTES } from "@app-mcp/format";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createApi } from "./api.js";
import type { Database } from "./db.js";
import { enableHosting } from "./hosted.js";
import { refreshServers, type Refresher } from "./refresh.js";
import { Store } from "./store.js";
import type { McpLogger } from "./mcp-log.js";
import type { Assets } from "./views.js";

export { Store, RegistryError, type Scope } from "./store.js";
export type { Database } from "./db.js";
export type { Refresher } from "./refresh.js";
export type { Assets } from "./views.js";
export type { McpLogger, McpLogLine } from "./mcp-log.js";

export interface RegistryAppOptions {
  /** The views and pages the registry serves, loaded by the runtime it runs on. */
  assets: Assets;
  staticHosting?: StaticHosting;
  /** Let refresh URLs use http and private addresses. For self-hosted installs and tests. */
  allowPrivateWebhooks?: boolean;
  /** Public URL of the registry, for the absolute URLs hosts are given (the connector icon). Default: each request's origin. */
  baseURL?: string;
  /** Where end-user MCP request lines go. Default: one JSON line per request on stdout (Workers Logs). */
  mcpLog?: McpLogger;
}

/** The registry without management: the /v1 API and the end-user MCP. Runtime-neutral: Node and Workers share it. */
export function createRegistryApp(db: Database, options: RegistryAppOptions): { app: Hono; store: Store; refresher: Refresher } {
  const store = new Store(db);
  const app = new Hono();
  app.use(bodyLimit({ maxSize: MAX_PUBLISH_BYTES * 2 }));
  if (options.staticHosting) {
    const hosting = options.staticHosting;
    const assetURL = new URL(hosting.baseURL.endsWith("/") ? hosting.baseURL : `${hosting.baseURL}/`);
    const prefix = assetURL.pathname;
    app.use(async (c, next) => {
      const url = new URL(c.req.url);
      if (
        options.baseURL &&
        assetURL.origin !== new URL(options.baseURL).origin &&
        url.origin === assetURL.origin &&
        (!url.pathname.startsWith(prefix) || !["GET", "HEAD"].includes(c.req.method))
      )
        return c.notFound();
      await next();
    });
    app.get(`${prefix}:key`, async (c) => {
      const key = c.req.param("key");
      if (!key || !/^[a-f0-9]{64}\.(js|css)$/.test(key)) return c.notFound();
      const asset = await hosting.store.get(key);
      if (!asset) return c.notFound();
      return new Response(new Uint8Array(asset.body), { headers: assetHeaders(asset.contentType) });
    });
  }
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1", createApi(store, options));
  enableHosting(app, store, options);
  // Companies' servers re-list app-mcp's tools right after a change, if their environment has a refresh URL.
  const refresher = refreshServers(store, { allowPrivate: options.allowPrivateWebhooks });
  return { app, store, refresher };
}
