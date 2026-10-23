import { PREVIEW_META_KEY, THEME_META_KEY, VIEW_ID_META_KEY } from "@genui/format";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { mountGenUI } from "./runtime.js";

async function connect() {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  await mountGenUI(server, { theme: { light: { primary: "#4f46e5" } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const form = {
  title: "New order",
  fields: [
    { name: "customer", label: "Customer", type: "resource_select", source: { toolName: "search_customers", searchParam: "query", labelPath: "name" } },
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

  it("returns theme and a view id in _meta", async () => {
    const result = await client.callTool({ name: "render_form", arguments: form });
    expect(result.isError).toBeFalsy();
    expect(result._meta).not.toHaveProperty(PREVIEW_META_KEY);
    expect(result._meta?.[THEME_META_KEY]).toEqual({ light: { primary: "#4f46e5" } });

    const again = await client.callTool({ name: "render_form", arguments: form });
    expect(result._meta?.[VIEW_ID_META_KEY]).toMatch(/^[0-9a-f-]{36}$/);
    expect(again._meta?.[VIEW_ID_META_KEY]).not.toBe(result._meta?.[VIEW_ID_META_KEY]);
  });

  it("names tools preview_* in preview mode and flags their results as previews", async () => {
    const server = new McpServer({ name: "preview", version: "1.0.0" });
    await mountGenUI(server, { preview: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const previewClient = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), previewClient.connect(a)]);
    const names = (await previewClient.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["preview_form", "preview_chart"]));
    expect(names).not.toContain("render_form");
    const result = await previewClient.callTool({ name: "preview_form", arguments: form });
    expect(result._meta?.[PREVIEW_META_KEY]).toBe(true);
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
    await mountGenUI(server, { dataTools: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const renderOnly = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), renderOnly.connect(a)]);

    const description = (await renderOnly.listTools()).tools.find((t) => t.name === "render_form")?.description;
    expect(description).toContain("no data tools");
    expect(description).not.toContain("resource_select");

    const rejected = await renderOnly.callTool({ name: "render_form", arguments: form });
    expect(rejected.isError).toBe(true);
    expect((rejected.content as { text: string }[])[0]?.text).toContain('field "customer" (search_customers), submit (create_order)');

    const sourced = await renderOnly.callTool({ name: "render_chart", arguments: { type: "line", data: { source: { toolName: "get_revenue" } } } });
    expect(sourced.isError).toBe(true);

    const inline = await renderOnly.callTool({ name: "render_form", arguments: { fields: [{ name: "notes", label: "Notes", type: "textarea" }] } });
    expect(inline.isError).toBeFalsy();
  });
});

describe("recipes", () => {
  const addOrder = {
    name: "add_order",
    title: "New order",
    when: "The user wants to create an order.",
    notes: "Pre-fill the customer when mentioned.",
    form: {
      title: "New order",
      fields: [
        { name: "customer", label: "Customer", type: "resource_select", source: { toolName: "search_customers", labelPath: "name" } },
        { name: "quantity", label: "Quantity", type: "number" },
      ],
      submit: { toolName: "create_order" },
    },
  } as const;
  const wipe = { name: "wipe", when: "Never.", form: { fields: [{ name: "x", label: "X", type: "text" }], submit: { toolName: "drop_tables" } } } as const;

  async function connectWithRecipes() {
    const server = new McpServer({ name: "recipes", version: "1.0.0" });
    await mountGenUI(server, { recipes: [addOrder as never, wipe as never] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const recipeClient = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), recipeClient.connect(a)]);
    return recipeClient;
  }

  it("builds the form on the server from the recipe and the model's pre-fill", async () => {
    const c = await connectWithRecipes();
    const tool = (await c.listTools()).tools.find((t) => t.name === "use_recipe");
    expect(tool?.description).toContain("- add_order: The user wants to create an order. Pre-fill the customer when mentioned.");

    const result = await c.callTool({ name: "use_recipe", arguments: { recipe: "add_order", prefill: { customer: { id: "c-2", label: "Globex" }, quantity: "3" } } });
    expect(result.isError).toBeFalsy();
    const form = result._meta?.["genui/form"] as { fields: { name: string; defaultValue?: unknown }[] };
    expect(form.fields.map((f) => f.defaultValue)).toEqual([{ id: "c-2", label: "Globex" }, 3]);
  });

  it("sends recipe values back to the conversation on a server without data tools", async () => {
    const server = new McpServer({ name: "render-only", version: "1.0.0" });
    await mountGenUI(server, { recipes: [wipe as never], dataTools: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), c.connect(a)]);
    const result = await c.callTool({ name: "use_recipe", arguments: { recipe: "wipe" } });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.["genui/form"]).not.toHaveProperty("submit");
  });

  it("checks recipes with `validate` through the app-only genui_validate tool", async () => {
    const quote = {
      name: "quote",
      when: "The user wants a quote.",
      form: { fields: [{ name: "email", label: "Email", type: "email" }] },
      validate: { url: "https://example.com/validate" },
    };
    const calls: { recipe: string; values: Record<string, unknown> }[] = [];
    const server = new McpServer({ name: "validated", version: "1.0.0" });
    await mountGenUI(server, {
      recipes: [quote as never, wipe as never],
      dataTools: false,
      validate: async (recipe, values) => {
        calls.push({ recipe: recipe.name, values });
        return values.email === "taken@example.com" ? { ok: false, fieldErrors: { email: "Already a customer." } } : { ok: true };
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([server.connect(b), c.connect(a)]);

    const tool = (await c.listTools()).tools.find((t) => t.name === "genui_validate");
    expect((tool?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);

    const shown = await c.callTool({ name: "use_recipe", arguments: { recipe: "quote" } });
    const submit = (shown._meta?.["genui/form"] as { submit?: { toolName: string; params: Record<string, unknown> } }).submit;
    expect(submit).toMatchObject({ toolName: "genui_validate", params: { genui_recipe: "quote" } });
    // Recipes without `validate` keep sending their values straight to the conversation.
    expect((await c.callTool({ name: "use_recipe", arguments: { recipe: "wipe" } }))._meta?.["genui/form"]).not.toHaveProperty("submit");

    // What the form sends: the fixed params with the field values merged in.
    const rejected = await c.callTool({ name: "genui_validate", arguments: { ...submit!.params, email: "taken@example.com" } });
    expect(rejected.structuredContent).toEqual({ ok: false, fieldErrors: { email: "Already a customer." } });
    const accepted = await c.callTool({ name: "genui_validate", arguments: { ...submit!.params, email: "new@example.com" } });
    expect(accepted.structuredContent).toEqual({ ok: true });
    expect(calls).toEqual([
      { recipe: "quote", values: { email: "taken@example.com" } },
      { recipe: "quote", values: { email: "new@example.com" } },
    ]);
  });

  it("exposes each recipe as a prompt (slash command)", async () => {
    const c = await connectWithRecipes();
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["add_order", "wipe"]);
    const prompt = await c.getPrompt({ name: "add_order", arguments: { details: "3 mugs for Globex" } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('call use_recipe with recipe "add_order"');
    expect(text).toContain("3 mugs for Globex");
  });
});
