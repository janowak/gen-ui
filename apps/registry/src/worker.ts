import hostedViewManifest from "../dist-static-views.txt";
import type { StaticAssetStore } from "./static-assets.js";
import consent from "../dist-web/consent.html";
import signIn from "../dist-web/sign-in.html";
import manage from "../dist-web/manage.html";
import cli from "../dist-web/cli.html";
import { createRegistryApp, type Refresher } from "./app.js";
import { authConfigFromEnv, type MetadataFetch } from "./auth.js";
import { d1Database, type D1Binding } from "./db-d1.js";
import { enableManagement } from "./management.js";
import type { Assets } from "./views.js";
import type { ExecutionContext, Hono } from "hono";

// The registry on Cloudflare Workers, with D1 as its database (wrangler.jsonc). main.ts runs it on Node.

interface Env {
  DB: D1Binding;
  ASSET_BUCKET: {
    put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  };
}

const assets: Assets = {
  ...JSON.parse(hostedViewManifest),
  pages: { "sign-in": signIn, consent, manage, cli },
};

/**
 * Client ID Metadata Documents over plain fetch. A Worker has no private network behind it to reach,
 * which is what the Node transport's DNS pinning protects; https only, and redirects are never followed:
 * Workers reject better-auth's `redirect: "error"`, and with "manual" a redirect fails as a non-200.
 */
const fetchClientMetadataResource: MetadataFetch = async (input, init) => {
  const request = new Request(input, { ...init, redirect: "manual" });
  if (new URL(request.url).protocol !== "https:") throw new TypeError("Client metadata is fetched over https only");
  return fetch(request);
};

interface Registry {
  app: Hono;
  refresher: Refresher;
  /** better-auth's setup and its one-time check of the D1 schema, which every auth request waits on. */
  ready: Promise<unknown>;
}

async function create(env: Env): Promise<Registry> {
  const settings = env as unknown as Record<string, string | undefined>;
  // A random secret per isolate would break every session and connector on the next isolate.
  if (!settings.APP_MCP_AUTH_SECRET) throw new Error("APP_MCP_AUTH_SECRET is not set. Run: wrangler secret put APP_MCP_AUTH_SECRET");
  const db = d1Database(env.DB);
  const config = authConfigFromEnv(settings);
  const assetStore: StaticAssetStore = {
    async put(key, body, contentType) {
      await env.ASSET_BUCKET.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await env.ASSET_BUCKET.get(key);
      return object
        ? { body: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? "application/octet-stream" }
        : undefined;
    },
  };
  const staticHosting = { baseURL: settings.APP_MCP_ASSET_URL ?? "https://assets.app-mcp.com/assets/", store: assetStore };
  const assetBase = new URL(staticHosting.baseURL.endsWith("/") ? staticHosting.baseURL : `${staticHosting.baseURL}/`);
  const hosted = JSON.parse(
    hostedViewManifest
      .replaceAll("https://app-mcp-assets.invalid/assets/", assetBase.href)
      .replaceAll("https://app-mcp-assets.invalid", assetBase.origin),
  ) as Pick<Assets, "views" | "viewMetadata">;
  const hostedAssets: Assets = { ...assets, ...hosted };
  const { app, store, refresher } = createRegistryApp(db, { assets: hostedAssets, staticHosting, baseURL: config.baseURL });
  const auth = enableManagement(app, db, store, config, { assets: hostedAssets, fetchClientMetadataResource });
  return { app, refresher, ready: auth.$context.then((context) => context.checkSchema?.()) };
}

// One registry per isolate: the bindings and settings don't change between its requests.
let pendingRegistry: Promise<Registry> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!pendingRegistry)
      pendingRegistry = create(env).catch((error) => {
        pendingRegistry = undefined;
        throw error;
      });
    ctx.waitUntil(pendingRegistry.then((r) => r.ready));
    const registry = await pendingRegistry;
    await registry.ready;
    const response = await registry.app.fetch(request, env, ctx);
    // A change starts its refresh URL calls during the request: keep the isolate until they're done.
    ctx.waitUntil(registry.refresher.idle());
    return response;
  },
};
