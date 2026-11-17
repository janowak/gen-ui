import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AddressInfo } from "node:net";
import { MAX_BUNDLE_BYTES } from "@app-mcp/format";
import { createRegistryApp } from "./app.js";
import { loadAssets, testDatabase } from "./testing.js";
import { externalize, type StaticAssetStore } from "./static-assets.js";
import { fileAssetStore } from "./static-assets-node.js";
import { hostViews } from "./views.js";

function memoryStore() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: StaticAssetStore = {
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async get(key) {
      return objects.get(key);
    },
  };
  return { store, objects };
}

it("extracts scripts/styles exactly, preserves JSON and adds only the static origin", async () => {
  const { store, objects } = memoryStore();
  const js = 'window.example = "<style>not CSS</style>";';
  const css = "body { color: red; }";
  const html = `<html><head><style media="screen">${css}</style></head><body><script type="application/json">{"data":1}</script><script type="module">${js}</script></body></html>`;
  const hosting = { baseURL: "https://cdn.acme.test/components/", store };
  const result = await externalize(html, hosting);
  expect(result.html).toContain('<script type="application/json">{"data":1}</script>');
  expect(result.html).toContain('rel="stylesheet"');
  expect(result.html).toContain('media="screen"');
  expect(result.html).toContain('type="module"');
  expect(result.html).toContain("https://cdn.acme.test/components/");
  expect([...objects.values()].map((o) => new TextDecoder().decode(o.body)).sort()).toEqual([js, css].sort());
  expect(result._meta).toEqual({ ui: { csp: { resourceDomains: ["https://cdn.acme.test"] } } });
  expect(await externalize(html, hosting)).toEqual(result);
  expect(objects.size).toBe(2);
});

it("publishes local files atomically under concurrent writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-mcp-assets-"));
  try {
    const store = fileAssetStore(directory);
    const key = `${"a".repeat(64)}.js`;
    const data = new TextEncoder().encode("x".repeat(100_000));
    await Promise.all(Array.from({ length: 5 }, () => store.put(key, data, "text/javascript")));
    expect(new Uint8Array((await store.get(key))!.body)).toEqual(data);
    await expect(store.get("../secret")).rejects.toThrow("Invalid asset key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("static publishing and MCP resources", () => {
  let server: ServerType;
  let base: string;
  let workspace: string;
  let token: string;
  let instance: ReturnType<typeof createRegistryApp>;
  const { store: assetStore, objects } = memoryStore();
  let failWrites = false;
  const storage: StaticAssetStore = {
    async put(...args) {
      if (failWrites) throw new Error("Storage unavailable");
      await assetStore.put(...args);
    },
    get: assetStore.get,
  };
  const staticHosting = { baseURL: "https://assets.app-mcp.com/assets/", store: storage };
  const manifest = { name: "static_test", version: "1.0.0", description: "Test", props: { type: "object" } };
  const html = `<html><head><style>body{color:red}</style></head><body><script type="module">window.large = "${"x".repeat(MAX_BUNDLE_BYTES + 1)}";</script></body></html>`;
  const publish = (version: string, source = html) =>
    instance.app.request("/v1/components", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ manifest: { ...manifest, version }, html: source }),
    });

  beforeAll(async () => {
    const assets = await hostViews(await loadAssets(), staticHosting);
    instance = createRegistryApp(await testDatabase(), { assets, staticHosting, baseURL: "https://api.app-mcp.com" });
    workspace = await instance.store.createWorkspace("static");
    token = await instance.store.createToken(workspace, "publish", "ci");
    server = serve({ fetch: instance.app.fetch, port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it("accepts a component beyond the D1 row limit and serves a tiny immutable shell", async () => {
    const response = await publish("1.0.0");
    expect(response.status).toBe(201);
    const result = (await response.json()) as { hash: string };
    const resource = await instance.store.resource(workspace, result.hash);
    expect(resource!.html.length).toBeLessThan(1000);
    expect(resource!._meta).toEqual({ ui: { csp: { resourceDomains: ["https://assets.app-mcp.com"] } } });
    const assetURL = /src="([^"]+)"/.exec(resource!.html)![1]!;
    const asset = await instance.app.request(new URL(assetURL).pathname);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("access-control-allow-origin")).toBe("*");
    expect(asset.headers.get("set-cookie")).toBeNull();
    expect((await asset.text()).length).toBeGreaterThan(MAX_BUNDLE_BYTES);
    expect((await publish("1.0.0")).status).toBe(200);
    expect((await publish("1.0.0", "<html><script>changed()</script></html>")).status).toBe(409);
  });

  it("keeps CSP on built-ins, current components and historical resources", async () => {
    const catalog = await instance.store.catalog(workspace, "prod");
    const oldHash = catalog.components[0]!.hash;
    expect((await publish("1.1.0", "<html><script>window.newVersion = true;</script></html>")).status).toBe(201);
    const client = new Client({ name: "host", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/w/static/mcp`)));
    try {
      const tools = (await client.listTools()).tools;
      const uris = ["render_form", "render_chart", "render_static_test"].map(
        (name) => (tools.find((t) => t.name === name)!._meta!.ui as { resourceUri: string }).resourceUri,
      );
      uris.push(`ui://app-mcp/c/static_test/${oldHash}`);
      for (const uri of uris) {
        const content = (await client.readResource({ uri })).contents[0]!;
        expect(content._meta).toEqual({ ui: { csp: { resourceDomains: ["https://assets.app-mcp.com"] } } });
        expect(content.text).toContain("https://assets.app-mcp.com/assets/");
      }
    } finally {
      await client.close();
    }
  });

  it("re-publishes pre-existing inline versions without changing their immutable resources", async () => {
    const original = "<html><script>window.legacy = true;</script></html>";
    const legacy = await instance.store.publish(workspace, { ...manifest, version: "0.1.0", tools: [] }, original);
    const response = await publish("0.1.0", original);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { hash: string }).hash).toBe(legacy.hash);
    expect((await instance.store.resource(workspace, legacy.hash))?.html).toBe(original);
  });

  it("exposes only immutable assets on a dedicated asset hostname", async () => {
    expect((await instance.app.request("https://assets.app-mcp.com/health")).status).toBe(404);
    expect((await instance.app.request("https://assets.app-mcp.com/v1/components")).status).toBe(404);
  });

  it("does not activate a version when an asset write fails", async () => {
    const before = await instance.store.catalog(workspace, "prod");
    failWrites = true;
    try {
      expect((await publish("2.0.0")).status).toBe(500);
    } finally {
      failWrites = false;
    }
    expect((await instance.store.catalog(workspace, "prod")).components).toEqual(before.components);
    expect((await instance.app.request("/assets/not-a-hash.js")).status).toBe(404);
    expect(objects.size).toBeGreaterThan(0);
  });
});
