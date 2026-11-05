import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "./asset-worker.js";

const key = `${"a".repeat(64)}.js`;
let cache: Map<string, Response>;
beforeEach(() => {
  cache = new Map();
  vi.stubGlobal("caches", {
    default: {
      async match(request: Request) {
        return cache.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        cache.set(request.url, response);
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("serves and caches public assets without initializing any registry/auth state", async () => {
  const body = new TextEncoder().encode("window.ready = true;");
  const get = vi.fn(async () => ({ arrayBuffer: async () => body.buffer, httpMetadata: { contentType: "text/javascript" } }));
  const env = { ASSET_BUCKET: { get }, STATIC_ASSETS: { fetch: vi.fn(async () => new Response("not found", { status: 404 })) } };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  };
  const request = new Request(`https://assets.app-mcp.com/assets/${key}`);
  const first = await worker.fetch(request, env, ctx);
  expect(await first.text()).toBe("window.ready = true;");
  expect(first.headers.get("cache-control")).toContain("immutable");
  expect(first.headers.get("access-control-allow-origin")).toBe("*");
  expect(first.headers.get("set-cookie")).toBeNull();
  await Promise.all(pending);
  const second = await worker.fetch(request, env, ctx);
  expect(await second.text()).toBe("window.ready = true;");
  expect(get).toHaveBeenCalledTimes(1);
  const head = await worker.fetch(new Request(request, { method: "HEAD" }), env, ctx);
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-type")).toBe("text/javascript");
  for (const path of ["/health", "/mcp", "/sign-in", "/assets/invalid.js"])
    expect((await worker.fetch(new Request(`https://assets.app-mcp.com${path}`), env, ctx)).status).toBe(404);
});

it("serves deployed built-ins with a configurable URL and does not cache misses", async () => {
  const env = {
    APP_MCP_ASSET_URL: "https://cdn.acme.test/components/",
    ASSET_BUCKET: { get: vi.fn(async () => null) },
    STATIC_ASSETS: {
      fetch: vi.fn(async (request: Request) =>
        new URL(request.url).pathname === `/assets/${key}` ? new Response("built in") : new Response("missing", { status: 404 }),
      ),
    },
  };
  const ctx = { waitUntil: vi.fn() };
  const response = await worker.fetch(new Request(`https://cdn.acme.test/components/${key}`), env, ctx);
  expect(await response.text()).toBe("built in");
  const missing = await worker.fetch(new Request(`https://cdn.acme.test/components/${"b".repeat(64)}.js`), env, ctx);
  expect(missing.status).toBe(404);
  expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
});
