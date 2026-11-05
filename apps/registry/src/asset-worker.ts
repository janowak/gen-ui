import { assetHeaders } from "./static-assets.js";

interface Env {
  APP_MCP_ASSET_URL?: string;
  STATIC_ASSETS: { fetch(request: Request): Promise<Response> };
  ASSET_BUCKET: {
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const assetBase = new URL(env.APP_MCP_ASSET_URL ?? "https://assets.app-mcp.com/assets/");
    const url = new URL(request.url);
    const prefix = assetBase.pathname.endsWith("/") ? assetBase.pathname : `${assetBase.pathname}/`;
    if (url.pathname.startsWith(prefix) && (request.method === "GET" || request.method === "HEAD")) {
      const key = url.pathname.slice(prefix.length);
      if (!/^[a-f0-9]{64}\.(js|css)$/.test(key)) return new Response("Not found", { status: 404 });
      const cache = (
        globalThis as unknown as {
          caches: {
            default: { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> };
          };
        }
      ).caches.default;
      const cacheKey = new Request(url.href, { method: "GET" });
      let response = await cache.match(cacheKey);
      if (!response) {
        const object = await env.ASSET_BUCKET.get(key);
        if (object)
          response = new Response(await object.arrayBuffer(), {
            headers: assetHeaders(object.httpMetadata?.contentType ?? "application/octet-stream"),
          });
        else {
          const staticURL = new URL(`/assets/${key}`, request.url);
          const deployed = await env.STATIC_ASSETS.fetch(new Request(staticURL));
          if (deployed.ok)
            response = new Response(deployed.body, {
              headers: assetHeaders(key.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8"),
            });
        }
        if (!response) return new Response("Not found", { status: 404 });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return request.method === "HEAD" ? new Response(null, response) : response;
    }
    return new Response("Not found", { status: 404 });
  },
};
