import type { AddressInfo } from "node:net";
import { createRegistryApp, loadAssets, openDatabase, type Refresher, type Store } from "@app-mcp/registry";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectAppMcp, mountAppMcp, refreshHandler, type AppMcpClient } from "./index.js";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const rating = (version: string) => ({
  name: "rating",
  version,
  description: "Ask the user to rate something.",
  props: { type: "object", properties: { question: { type: "string" } } },
  tools: [],
});

let registry: ServerType;
let store: Store;
let refresher: Refresher;
let acme: string;
let url: string;
let token: string;
let upstream = 0;
const counted: typeof fetch = (input, init) => {
  upstream++;
  return fetch(input, init);
};
const servers: ServerType[] = [];
const clients: AppMcpClient[] = [];

function listen(fetchHandler: (request: Request) => Response | Promise<Response>): Promise<ServerType> {
  const server = serve({ fetch: fetchHandler, port: 0 });
  servers.push(server);
  return new Promise((resolve) => server.once("listening", () => resolve(server)));
}
const port = (server: ServerType) => (server.address() as AddressInfo).port;

function connect(refreshSeconds = 0): AppMcpClient {
  const appMcp = connectAppMcp({ url, token, refreshSeconds, fetch: counted, logger: { warn: () => {} } });
  clients.push(appMcp);
  return appMcp;
}

/** The company's own server with app-mcp's tools, as a host sees it. */
async function companyServer(appMcp: AppMcpClient) {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  await mountAppMcp(server, { appMcp, watch: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "1.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const notified = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", notified);
  return { client, notified };
}

async function ratingUri(client: Client): Promise<string | undefined> {
  const tool = (await client.listTools()).tools.find((t) => t.name === "render_rating");
  return (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
}

beforeAll(async () => {
  const created = createRegistryApp(openDatabase(":memory:"), { assets: await loadAssets(), allowPrivateWebhooks: true });
  ({ store, refresher } = created);
  acme = await store.createWorkspace("Acme");
  token = await store.createToken(acme, "server", "acme-mcp");
  await store.publish(acme, rating("1.0.0"), html("rating v1"));
  await store.publish(acme, rating("1.1.0"), html("rating v1.1"), "prod");
  await store.deployVersion(acme, "rating", "1.0.0", "prod");
  registry = await listen(created.app.fetch);
  url = `http://localhost:${port(registry)}/w/acme/mcp`;
});

afterAll(() => {
  for (const client of clients) client.close();
  for (const server of servers) server.close();
});

describe("refresh", () => {
  it("re-lists app-mcp's tools only when the environment's revision changed", async () => {
    const appMcp = connect();
    await appMcp.ready();
    expect(appMcp.revision()).toBe((await store.environment(acme, "prod"))?.revision);

    const before = upstream;
    await appMcp.refresh();
    expect(upstream).toBe(before + 1); // the revision, nothing else

    await store.deployVersion(acme, "rating", "1.1.0", "prod");
    await appMcp.refresh();
    expect(upstream).toBeGreaterThan(before + 2);
    expect(appMcp.revision()).toBe((await store.environment(acme, "prod"))?.revision);
    await store.deployVersion(acme, "rating", "1.0.0", "prod");
  });

  it("checks an old copy in the background when app-mcp's tools are used", async () => {
    const appMcp = connect(0.05);
    const { client, notified } = await companyServer(appMcp);
    const before = await ratingUri(client);

    await store.deployVersion(acme, "rating", "1.1.0", "prod");
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Answered from the copy at once; the check runs after it.
    await client.callTool({ name: "render_form", arguments: { fields: [{ name: "notes", label: "Notes", type: "textarea" }] } });
    await vi.waitFor(() => expect(notified).toHaveBeenCalled());
    expect(await ratingUri(client)).not.toBe(before);
    await store.deployVersion(acme, "rating", "1.0.0", "prod");
  });

  it("updates a watching server right away when app-mcp calls its refresh endpoint", async () => {
    const appMcp = connect();
    const { client, notified } = await companyServer(appMcp);
    const before = await ratingUri(client);
    const endpoint = await listen(refreshHandler(appMcp));
    await store.setRefreshUrl(acme, "prod", `http://localhost:${port(endpoint)}/app-mcp/refresh`);

    await store.deployVersion(acme, "rating", "1.1.0", "prod");
    await refresher.idle();
    await vi.waitFor(() => expect(notified).toHaveBeenCalled());
    expect(await ratingUri(client)).not.toBe(before);
    expect((await store.environment(acme, "prod"))?.lastRefresh).toMatchObject({ ok: true, status: 202 });

    await store.setRefreshUrl(acme, "prod", null);
    await store.deployVersion(acme, "rating", "1.0.0", "prod");
  });

  it("ignores refresh calls for a revision it already has, and anything but POST", async () => {
    const appMcp = connect();
    await appMcp.ready();
    const handle = refreshHandler(appMcp);
    const post = (body: unknown) => handle(new Request("http://acme.test/app-mcp/refresh", { method: "POST", body: JSON.stringify(body) }));

    const before = upstream;
    const res = await post({ type: "app-mcp.refresh", environment: "prod", revision: appMcp.revision() });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ revision: appMcp.revision() });
    expect(upstream).toBe(before);
    expect((await handle(new Request("http://acme.test/app-mcp/refresh"))).status).toBe(405);

    await post({ revision: appMcp.revision()! + 1 });
    await vi.waitFor(() => expect(upstream).toBe(before + 1));
  });
});
