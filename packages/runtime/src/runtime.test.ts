import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PREVIEW_META_KEY, THEME_META_KEY, VIEW_CONTENT_KEY, VIEW_ID_META_KEY } from "@app-mcp/format";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { mountGenUI, type CatalogSource } from "./runtime.js";
import { viewBundles } from "./views.js";

const require = createRequire(import.meta.url);
const view = (name: string) => readFile(require.resolve(`@app-mcp/ui/views/${name}.html`), "utf8");
const views = viewBundles({ form: await view("form"), chart: await view("chart") });

async function connect() {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  await mountGenUI(server, { views, theme: { light: { primary: "#4f46e5" } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const form = {
  title: "New order",
  fields: [
    {
      name: "customer",
      label: "Customer",
      type: "resource_select",
      source: { toolName: "search_customers", searchParam: "query", labelPath: "name" },
    },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
  submit: { toolName: "create_order" },
};

describe("mountGenUI", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });

  it("registers render tools linked to content-hashed ui:// resources", async () => {
    const { tools } = await client.listTools();
    const formTool = tools.find((t) => t.name === "render_form");
    const chartTool = tools.find((t) => t.name === "render_chart");
    const uri = (formTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
    expect(uri).toMatch(/^ui:\/\/genui\/form\/[0-9a-f]{16}$/);
    expect(chartTool).toBeDefined();

    const resource = await client.readResource({ uri: uri! });
    const content = resource.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("<html");
  });

  it("returns the theme in _meta and a fresh render id in structuredContent and _meta", async () => {
    const result = await client.callTool({ name: "render_form", arguments: form });
    expect(result.isError).toBeFalsy();
    expect(result._meta).not.toHaveProperty(PREVIEW_META_KEY);
    expect(result._meta?.[THEME_META_KEY]).toEqual({ light: { primary: "#4f46e5" } });

    const again = await client.callTool({ name: "render_form", arguments: form });
    expect(result._meta?.[VIEW_ID_META_KEY]).toMatch(/^[0-9a-f-]{36}$/);
    expect(again._meta?.[VIEW_ID_META_KEY]).not.toBe(result._meta?.[VIEW_ID_META_KEY]);
    expect(result.structuredContent).toEqual({ [VIEW_CONTENT_KEY]: { id: result._meta?.[VIEW_ID_META_KEY] } });
  });

  it("names tools preview_* in preview mode and flags their results as previews", async () => {
    const server = new McpServer({ name: "preview", version: "1.0.0" });
    await mountGenUI(server, { views, preview: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const previewClient = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), previewClient.connect(a)]);
    const names = (await previewClient.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["preview_form", "preview_chart"]));
    expect(names).not.toContain("render_form");
    const result = await previewClient.callTool({ name: "preview_form", arguments: form });
    expect(result._meta?.[PREVIEW_META_KEY]).toBe(true);
  });

  it("suffixes tool names and titles outside prod, so an environment's connector can sit next to prod's", async () => {
    const server = new McpServer({ name: "staging", version: "1.0.0" });
    await mountGenUI(server, { views, environment: "staging" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const stagingClient = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), stagingClient.connect(a)]);
    const tools = (await stagingClient.listTools()).tools;
    expect(tools.map((t) => [t.name, t.title])).toEqual([
      ["render_form_staging", "Show form (staging)"],
      ["render_chart_staging", "Show chart (staging)"],
    ]);
    // The views are the same bundles, so their ui:// URIs match prod's.
    const prodUri = ((await client.listTools()).tools.find((t) => t.name === "render_form")!._meta as { ui: { resourceUri: string } }).ui
      .resourceUri;
    expect((tools[0]!._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(prodUri);
  });

  it("renders inline charts", async () => {
    const result = await client.callTool({
      name: "render_chart",
      arguments: { type: "pie", data: { categories: ["A", "B"], series: [{ name: "n", values: [1, 2] }] } },
    });
    expect(result.isError).toBeFalsy();
  });

  it("rejects specs that use tools on a server without data tools", async () => {
    const server = new McpServer({ name: "render-only", version: "1.0.0" });
    await mountGenUI(server, { views, dataTools: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const renderOnly = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), renderOnly.connect(a)]);

    const description = (await renderOnly.listTools()).tools.find((t) => t.name === "render_form")?.description;
    expect(description).toContain("no data tools");
    expect(description).not.toContain("resource_select");

    const rejected = await renderOnly.callTool({ name: "render_form", arguments: form });
    expect(rejected.isError).toBe(true);
    expect((rejected.content as { text: string }[])[0]?.text).toContain('field "customer" (search_customers), submit (create_order)');

    const sourced = await renderOnly.callTool({
      name: "render_chart",
      arguments: { type: "line", data: { source: { toolName: "get_revenue" } } },
    });
    expect(sourced.isError).toBe(true);

    const inline = await renderOnly.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "notes", label: "Notes", type: "textarea" }] },
    });
    expect(inline.isError).toBeFalsy();
  });
});

describe("workflows", () => {
  const createOrder = {
    name: "create_order",
    title: "New order",
    description: "The user wants to create an order.",
    instructions: "Look the customer up, then show the order form and submit to create_order.",
    params: [
      { name: "customer", description: "Customer name", required: true },
      { name: "notes", description: "Anything else", required: false },
    ],
  };
  const feedback = { name: "feedback", description: "After an order.", instructions: "Ask for a rating with render_rating.", params: [] };
  const source = (): CatalogSource => ({
    snapshot: async () => ({
      catalog: { environment: "prod", theme: null, instructions: null, workflows: [createOrder, feedback], components: [] },
      bundles: {},
    }),
  });

  async function connectWith(options: { environment?: string; preview?: boolean } = {}) {
    const server = new McpServer({ name: "workflows", version: "1.0.0" });
    await mountGenUI(server, { views, registry: source(), ...options });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), c.connect(a)]);
    return c;
  }

  it("makes workflows with params slash commands taking them; the others stay out", async () => {
    const c = await connectWith();
    const { prompts } = await c.listPrompts();
    expect(prompts).toEqual([
      expect.objectContaining({
        name: "create_order",
        title: "New order",
        description: "The user wants to create an order.",
        arguments: [
          { name: "customer", description: "Customer name", required: true },
          { name: "notes", description: "Anything else", required: false },
        ],
      }),
    ]);
    const prompt = await c.getPrompt({ name: "create_order", arguments: { customer: "Globex" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toBe(`${createOrder.instructions}\n\ncustomer: Globex`);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("use_recipe");
  });

  it("suffixes command names outside prod and leaves them out of previews", async () => {
    expect((await (await connectWith({ environment: "staging" })).listPrompts()).prompts.map((p) => [p.name, p.title])).toEqual([
      ["create_order_staging", "New order (staging)"],
    ]);
    const preview = await connectWith({ preview: true });
    expect(preview.getServerCapabilities()?.prompts).toBeUndefined();
  });
});

describe("components", () => {
  const manifest = (version: string) => ({
    name: "rating",
    version,
    description: "Ask the user to rate something.",
    props: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    tools: [],
  });
  const bundles: Record<string, string> = { aaaa: "<p>rating 1.0.0</p>", bbbb: "<p>rating 1.1.0</p>" };
  const source = (hash: string, version: string): CatalogSource => ({
    snapshot: async () => ({
      catalog: {
        environment: "prod",
        theme: null,
        instructions: null,
        workflows: [],
        components: [{ name: "rating", version, hash, manifest: manifest(version) }],
      },
      bundles: { [hash]: bundles[hash]! },
    }),
    bundle: async (h) => bundles[h],
  });

  async function connectTo(server: McpServer) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("serves earlier versions by hash through the source's bundle lookup", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    await mountGenUI(server, { views, registry: source("bbbb", "1.1.0") });
    const c = await connectTo(server);
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "render_rating")?._meta?.ui).toEqual({ resourceUri: "ui://genui/c/rating/bbbb" });
    const old = await c.readResource({ uri: "ui://genui/c/rating/aaaa" });
    expect((old.contents[0] as { text: string }).text).toBe("<p>rating 1.0.0</p>");
    await expect(c.readResource({ uri: "ui://genui/c/rating/ffff" })).rejects.toThrow();
  });

  it("remove() takes everything off the server, so it can be mounted again with a new snapshot", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const mounted = await mountGenUI(server, { views, registry: source("aaaa", "1.0.0") });
    const c = await connectTo(server);
    const changed = new Promise<void>((resolve) => c.setNotificationHandler("notifications/tools/list_changed", () => resolve()));

    mounted.remove();
    expect((await c.listTools()).tools).toEqual([]);
    await mountGenUI(server, { views, registry: source("bbbb", "1.1.0") });
    await changed;

    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "render_rating")?._meta?.ui).toEqual({ resourceUri: "ui://genui/c/rating/bbbb" });
    expect(tools.map((t) => t.name).sort()).toEqual(["render_chart", "render_form", "render_rating"]);
  });
});
