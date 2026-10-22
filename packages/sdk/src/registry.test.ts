import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPONENT_CONTRACT, THEME_META_KEY } from "@genui/format";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createRegistryApp, openDatabase } from "@genui/registry";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRegistryClient, mountGenUI, type RegistryClient } from "./index.js";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const rating = (version: string) => ({
  name: "rating",
  version,
  title: "Star rating",
  description: "Ask the user to rate something from 1 to 5 stars.",
  props: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  tools: ["save_rating"],
});

let http: ServerType;
let url: string;
let admin: string;
let serverToken: string;
const clients: RegistryClient[] = [];

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function connect(registry: RegistryClient, channel: "beta" | "stable", watch = false) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const handle = await mountGenUI(server, { registry, channel, watch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, handle };
}

const uriOf = async (client: Client, tool: string) =>
  ((await client.listTools()).tools.find((t) => t.name === tool)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;

beforeAll(async () => {
  const { app, store } = createRegistryApp(openDatabase(":memory:"));
  const ws = store.createWorkspace("acme");
  admin = store.createToken(ws, "admin", "test");
  serverToken = store.createToken(ws, "server", "sdk");
  http = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => http.once("listening", r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;

  await api("POST", "/v1/components", admin, { manifest: rating("1.0.0"), html: html("v1") });
  await api("POST", "/v1/components/rating/promote", admin, {});
  await api("POST", "/v1/components", admin, { manifest: rating("1.1.0"), html: html("v1.1") });
  await api("PUT", "/v1/theme", admin, { theme: { light: { primary: "#16a34a" } } });
});

afterAll(() => {
  clients.forEach((c) => c.close());
  http.close();
});

function registryClient(extra: Partial<Parameters<typeof createRegistryClient>[0]> = {}) {
  const client = createRegistryClient({ url, token: serverToken, refreshSeconds: 0, logger: { warn: () => {} }, ...extra });
  clients.push(client);
  return client;
}

describe("registry components", () => {
  it("mounts the channel's version as render_<name> with the registry theme", async () => {
    const registry = registryClient();
    const stable = await connect(registry, "stable");
    const beta = await connect(registry, "beta");

    expect(stable.handle.components()).toEqual(["rating@1.0.0"]);
    expect(beta.handle.components()).toEqual(["rating@1.1.0"]);
    const stableUri = await uriOf(stable.client, "render_rating");
    expect(stableUri).toMatch(/^ui:\/\/genui\/c\/rating\/[0-9a-f]{16}$/);
    expect(await uriOf(beta.client, "render_rating")).not.toBe(stableUri);

    const resource = await stable.client.readResource({ uri: stableUri! });
    expect((resource.contents[0] as { text: string }).text).toContain("v1");

    const result = await stable.client.callTool({ name: "render_rating", arguments: { question: "How was it?" } });
    expect(result._meta?.[THEME_META_KEY]).toEqual({ light: { primary: "#16a34a" } });

    const invalid = await stable.client.callTool({ name: "render_rating", arguments: {} }).catch((e: Error) => ({ isError: true, error: e.message }));
    expect(invalid.isError).toBe(true); // props schema is enforced
  });

  it("re-syncs a watching server when stable is promoted", async () => {
    const registry = registryClient();
    const { client, handle } = await connect(registry, "stable", true);
    const before = await uriOf(client, "render_rating");

    await api("POST", "/v1/components/rating/promote", admin, {});
    await registry.refresh();

    expect(handle.components()).toEqual(["rating@1.1.0"]);
    expect(await uriOf(client, "render_rating")).not.toBe(before);

    await api("POST", "/v1/components/rating/rollback", admin, { channel: "stable" });
    await registry.refresh();
    expect(handle.components()).toEqual(["rating@1.0.0"]);
    expect(await uriOf(client, "render_rating")).toBe(before);
    handle.close();
  });

  it("keeps the last good version when the registry is unreachable, including after a restart", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "genui-")), "cache.json");
    const first = registryClient({ cacheFile });
    await first.ready();
    expect(first.snapshot("stable")?.catalog.components[0]?.version).toBe("1.0.0");

    const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await first.refresh(); // still fine
    const restarted = registryClient({ cacheFile, fetch: down });
    await restarted.ready();
    expect(restarted.snapshot("stable")?.catalog.components[0]?.version).toBe("1.0.0");

    const { handle } = await connect(restarted, "stable");
    expect(handle.components()).toEqual(["rating@1.0.0"]);
  });

  it("skips components built for a newer component contract than this SDK serves", async () => {
    const future = { ...rating("1.0.0"), name: "future", contract: COMPONENT_CONTRACT + 1 };
    await api("POST", "/v1/components", admin, { manifest: future, html: html("future") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { handle } = await connect(registryClient(), "beta");
    expect(handle.components()).toEqual(["rating@1.1.0"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`needs component contract ${COMPONENT_CONTRACT + 1}`));
    warn.mockRestore();
  });
});
