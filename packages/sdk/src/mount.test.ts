import type { AddressInfo } from "node:net";
import { createRegistryApp, loadAssets, openDatabase, type Store } from "@app-mcp/registry";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectGenUI, mountGenUI, type GenUIClient } from "./index.js";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const rating = (version: string) => ({
  name: "rating",
  version,
  description: "Ask the user to rate something.",
  props: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  tools: ["save_rating"],
});

let registry: ServerType;
let store: Store;
let acme: string;
let url: string;
let stagingUrl: string;
let token: string;
/** Requests the adapter sent to genui. */
let upstream = 0;
const counted: typeof fetch = (input, init) => {
  upstream++;
  return fetch(input, init);
};

function listen(app: { fetch: (request: Request) => Response | Promise<Response> }): Promise<ServerType> {
  const server = serve({ fetch: app.fetch, port: 0 });
  return new Promise((resolve) => server.once("listening", () => resolve(server)));
}
const port = (server: ServerType) => (server.address() as AddressInfo).port;

/** The company's own server: its data tools plus genui's, as a host sees it. */
async function companyServer(genui: GenUIClient, watch = false) {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  server.registerTool(
    "search_customers",
    { description: "Search customers.", inputSchema: z.object({ query: z.string().optional() }) },
    async () => ({
      content: [{ type: "text", text: "[]" }],
    }),
  );
  const handle = await mountGenUI(server, { genui, watch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "1.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, handle, server };
}

async function resourceUri(client: Client, tool: string): Promise<string> {
  const found = (await client.listTools()).tools.find((t) => t.name === tool);
  return (found!._meta as { ui: { resourceUri: string } }).ui.resourceUri;
}

async function resourceText(client: Client, tool: string): Promise<string | undefined> {
  return ((await client.readResource({ uri: await resourceUri(client, tool) })).contents[0] as { text?: string }).text;
}

beforeAll(async () => {
  const created = createRegistryApp(openDatabase(":memory:"), { assets: await loadAssets() });
  store = created.store;
  acme = await store.createWorkspace("Acme");
  await store.createEnvironment(acme, "staging");
  token = await store.createToken(acme, "server", "acme-mcp");
  await store.publish(acme, rating("1.0.0"), html("rating v1"));
  await store.publish(acme, rating("1.1.0"), html("rating v1.1"), "staging");
  await store.setTheme(acme, "prod", { light: { primary: "#16a34a" } });
  await store.saveWorkflow(acme, "prod", {
    name: "add_item",
    description: "The user wants to add an item.",
    instructions: "Show a form with the name and submit to create_item.",
    params: [{ name: "item", description: "What to add", required: false }],
  });
  registry = await listen(created.app);
  url = `http://localhost:${port(registry)}/w/${acme}/mcp`;
  stagingUrl = `http://localhost:${port(registry)}/w/${acme}/staging/mcp`;
});

afterAll(() => registry?.close());

describe("mountGenUI", () => {
  const connect = (to = url) => connectGenUI({ url: to, token, refreshSeconds: 0, fetch: counted, logger: { warn: () => {} } });

  it("puts genui's tools and workflow prompts next to the company's own tools", async () => {
    const { client, handle } = await companyServer(connect());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_customers", "render_form", "render_chart", "render_rating"]));
    expect(handle.tools()).not.toContain("search_customers");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["add_item"]);

    const prompt = await client.getPrompt({ name: "add_item", arguments: { item: "a blue mug" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("item: a blue mug");
  });

  it("forwards calls and returns genui's result: theme and view id", async () => {
    const { client } = await companyServer(connect());
    const rendered = await client.callTool({ name: "render_rating", arguments: { question: "How was it?" } });
    expect(rendered._meta).toMatchObject({ "genui/theme": { light: { primary: "#16a34a" } } });
    expect(rendered._meta?.["genui/viewId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(rendered.structuredContent).toEqual({ genui: { id: rendered._meta?.["genui/viewId"] } });
  });

  it("answers tools/list and resource reads from memory; only calls reach genui", async () => {
    const { client } = await companyServer(connect());
    const before = upstream;
    expect(await resourceText(client, "render_rating")).toBe(html("rating v1"));
    expect(await resourceText(client, "render_rating")).toBe(html("rating v1"));
    await client.listTools();
    expect(upstream).toBe(before);

    await client.callTool({ name: "render_form", arguments: { fields: [{ name: "notes", label: "Notes", type: "textarea" }] } });
    expect(upstream).toBeGreaterThan(before);
  });

  it("serves the environment its client's URL points at", async () => {
    expect(await resourceText((await companyServer(connect())).client, "render_rating")).toBe(html("rating v1"));
    // Outside prod, genui suffixes the names; the SDK mirrors them as listed.
    const staging = (await companyServer(connect(stagingUrl))).client;
    expect((await staging.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_customers", "render_form_staging", "render_chart_staging", "render_rating_staging"]),
    );
    expect(await resourceText(staging, "render_rating_staging")).toBe(html("rating v1.1"));
  });

  it("re-syncs long-lived servers and notifies the host when genui changes", async () => {
    const genui = connect();
    const { client, handle } = await companyServer(genui, true);
    const notified = vi.fn();
    client.setNotificationHandler("notifications/tools/list_changed", notified);
    const before = await resourceUri(client, "render_rating");

    await store.deployVersion(acme, "rating", "1.1.0", "prod");
    await genui.refresh();
    await vi.waitFor(() => expect(notified).toHaveBeenCalled());
    const after = await resourceUri(client, "render_rating");
    expect(after).not.toBe(before);
    expect(await resourceText(client, "render_rating")).toBe(html("rating v1.1"));

    // An old message still renders: the earlier version is read from genui by its hash.
    expect(((await client.readResource({ uri: before })).contents[0] as { text?: string }).text).toBe(html("rating v1"));
    handle.close();
    await store.publish(acme, rating("1.0.0"), html("rating v1"));
  });

  it("returns a clear error when genui is unreachable", async () => {
    const second = createRegistryApp(openDatabase(":memory:"), { assets: await loadAssets() });
    const ws = await second.store.createWorkspace("Down");
    const down = await listen(second.app);
    const genui = connectGenUI({
      url: `http://localhost:${port(down)}/w/${ws}/mcp`,
      token: await second.store.createToken(ws, "server", "down"),
      refreshSeconds: 0,
      logger: { warn: () => {} },
    });
    const { client } = await companyServer(genui);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("render_form");

    await new Promise<void>((resolve) => {
      down.close(() => resolve());
      (down as unknown as { closeAllConnections(): void }).closeAllConnections();
    });
    const result = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "notes", label: "Notes", type: "textarea" }] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toBe("genui is unavailable right now, try again shortly.");
  });

  it("mounts nothing with a bad token, and says why", async () => {
    const warn = vi.fn();
    const genui = connectGenUI({ url, token: "gnu_server_nope", refreshSeconds: 0, logger: { warn } });
    const { client } = await companyServer(genui);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["search_customers"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not list genui's tools"));
  });
});
