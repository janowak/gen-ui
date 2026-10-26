import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistryApp, openDatabase, type Store } from "./app.js";
import { signature } from "./webhook.js";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const component = (name: string, version: string) => ({
  name,
  version,
  description: `Show ${name}.`,
  props: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  tools: [],
});

let server: ServerType;
let base: string;
let store: Store;
let acme: string;
let other: string;
let admin: string;

// The company's validation webhook: checks our signature, rejects emails of existing customers.
let webhook: Server;
const received: { signed: boolean; body: { recipe: string; values: Record<string, unknown> } }[] = [];

function startWebhook(): Promise<string> {
  webhook = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(req.headers["x-genui-signature"])) ?? [];
      const signed = v1 === signature(store.webhookSecret(acme), Number(t), raw);
      const body = JSON.parse(raw) as { recipe: string; values: { email?: string } };
      received.push({ signed, body });
      const taken = body.values.email === "taken@acme.test";
      res.writeHead(taken ? 422 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(taken ? { ok: false, fieldErrors: { email: "Already a customer." } } : { ok: true, message: "We'll be in touch." }));
    });
  });
  return new Promise((resolve) => webhook.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(webhook.address() as AddressInfo).port}/validate`)));
}

async function mcpClient(path: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), headers && { requestInit: { headers } }));
  return client;
}

async function resourceText(client: Client, tool: string): Promise<string | undefined> {
  const { tools } = await client.listTools();
  const uri = (tools.find((t) => t.name === tool)?._meta as { ui: { resourceUri: string } }).ui.resourceUri;
  return ((await client.readResource({ uri })).contents[0] as { text?: string }).text;
}

beforeAll(async () => {
  const webhookUrl = await startWebhook();
  const created = createRegistryApp(openDatabase(":memory:"), { allowPrivateWebhooks: true });
  store = created.store;
  acme = store.createWorkspace("Acme");
  store.createEnvironment(acme, "staging");
  admin = store.createToken(acme, "admin", "test");
  store.publish(acme, component("rating", "1.0.0"), html("rating v1"));
  store.publish(acme, component("rating", "1.1.0"), html("rating v1.1"), "staging");
  store.setTheme(acme, "prod", { light: { primary: "#16a34a" } });
  store.saveRecipe(acme, "prod", {
    name: "add_item",
    when: "The user wants to add an item.",
    form: { fields: [{ name: "name", label: "Name", type: "text", required: true }], submit: { toolName: "create_item" } },
  });
  store.saveRecipe(acme, "prod", {
    name: "quote",
    when: "The user wants a quote.",
    form: { fields: [{ name: "email", label: "Email", type: "email", required: true }] },
    validate: { url: webhookUrl },
  });

  other = store.createWorkspace("Other");
  store.publish(other, component("survey", "1.0.0"), html("survey"));

  server = serve({ fetch: created.app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  webhook?.close();
});

describe("hosted end-user MCP", () => {
  it("is public by default; an admin can make it private", async () => {
    const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await post("/w/no-such-workspace/mcp")).status).toBe(404);

    const current = await fetch(`${base}/v1/hosting`, { headers: { authorization: `Bearer ${admin}` } });
    expect(await current.json()).toEqual({ hosted: true, paths: { prod: `/w/${acme}/mcp`, staging: `/w/${acme}/staging/mcp` } });

    const set = (enabled: boolean) =>
      fetch(`${base}/v1/hosting`, {
        method: "PUT",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    expect(((await (await set(false)).json()) as { hosted: boolean }).hosted).toBe(false);
    expect((await post(`/w/${acme}/mcp`)).status).toBe(404);
    const on = await set(true);
    expect(((await on.json()) as { hosted: boolean }).hosted).toBe(true);
  });

  it("serves the workspace's render tools, components and recipes, with no admin tools", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`);
    expect(client.getServerVersion()?.name).toBe("Acme");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["render_form", "render_chart", "render_rating", "use_recipe"]));
    expect(names.some((n) => n.startsWith("preview_") || n.startsWith("component_") || n.startsWith("theme_"))).toBe(false);
    expect(names).not.toContain("render_survey");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["add_item", "quote"]);

    // Prod serves what was published to prod, with prod's theme and no preview flag.
    expect(await resourceText(client, "render_rating")).toBe(html("rating v1"));
    const rendered = await client.callTool({ name: "render_rating", arguments: { question: "How was it?" } });
    expect(rendered._meta).toMatchObject({ "genui/theme": { light: { primary: "#16a34a" } } });
    expect(rendered._meta).not.toHaveProperty("genui/preview");
  });

  it("serves another environment at its own address, with suffixed names and its own recipes", async () => {
    const client = await mcpClient(`/w/${acme}/staging/mcp`);
    expect(client.getServerVersion()?.name).toBe("Acme (staging)");
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["render_chart_staging", "render_form_staging", "render_rating_staging"]);
    expect(tools.find((t) => t.name === "render_form_staging")?.title).toBe("Show form (staging)");
    expect(await resourceText(client, "render_rating_staging")).toBe(html("rating v1.1"));
    // Staging has no recipes or theme of its own yet: prod's don't leak in.
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    const rendered = await client.callTool({ name: "render_rating_staging", arguments: { question: "How was it?" } });
    expect(rendered._meta).not.toHaveProperty("genui/theme");

    store.saveRecipe(acme, "staging", { name: "add_item", when: "The user wants to add an item.", form: { fields: [{ name: "name", label: "Name", type: "text" }] } });
    const again = await mcpClient(`/w/${acme}/staging/mcp`);
    expect((await again.listPrompts()).prompts.map((p) => p.name)).toEqual(["add_item_staging"]);
    const recipeTool = (await again.listTools()).tools.find((t) => t.name === "use_recipe_staging");
    expect(recipeTool?.description).toContain("Prefer it over render_form_staging");
    expect((await again.getPrompt({ name: "add_item_staging", arguments: {} })).messages[0]?.content).toMatchObject({ text: expect.stringContaining("call use_recipe_staging") });
  });

  it("answers 404 for an environment that doesn't exist", async () => {
    const res = await fetch(`${base}/w/${acme}/stagng/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No environment "stagng" in this workspace.' });
  });

  it("renders inline data only; recipe values go back to the conversation", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`);
    const withSubmit = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "email", label: "Email", type: "email" }], submit: { toolName: "create_lead" } },
    });
    expect(withSubmit.isError).toBe(true);

    const inline = await client.callTool({ name: "render_form", arguments: { fields: [{ name: "email", label: "Email", type: "email" }] } });
    expect(inline.isError).toBeFalsy();

    const recipe = await client.callTool({ name: "use_recipe", arguments: { recipe: "add_item", prefill: { name: "Mug" } } });
    expect(recipe.isError).toBeFalsy();
    expect(recipe._meta?.["genui/form"]).toMatchObject({ fields: [{ name: "name", defaultValue: "Mug" }] });
    expect(recipe._meta?.["genui/form"]).not.toHaveProperty("submit");
  });

  it("checks a recipe's values with its signed validation webhook", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`);
    const shown = await client.callTool({ name: "use_recipe", arguments: { recipe: "quote" } });
    const submit = (shown._meta?.["genui/form"] as { submit: { toolName: string; params: Record<string, unknown>; idempotencyParam: string } }).submit;
    expect(submit.toolName).toBe("genui_validate");

    // What the form sends on submit: the fixed params with the field values and its render id merged in.
    const view = { [submit.idempotencyParam]: shown._meta?.["genui/viewId"] };
    const rejected = await client.callTool({ name: submit.toolName, arguments: { ...submit.params, email: "taken@acme.test", ...view } });
    expect(rejected.structuredContent).toEqual({ ok: false, fieldErrors: { email: "Already a customer." } });
    const accepted = await client.callTool({ name: submit.toolName, arguments: { ...submit.params, email: "new@acme.test", ...view } });
    expect(accepted.structuredContent).toEqual({ ok: true, message: "We'll be in touch." });

    const viewId = shown._meta?.["genui/viewId"];
    expect(received).toEqual([
      { signed: true, body: expect.objectContaining({ recipe: "quote", viewId, values: { email: "taken@acme.test" } }) },
      { signed: true, body: expect.objectContaining({ recipe: "quote", viewId, values: { email: "new@acme.test" } }) },
    ]);

    // Admins read the signing secret from the API; rotating it replaces it.
    const read = async (method: string) =>
      ((await (await fetch(`${base}/v1/hosting/webhook-secret`, { method, headers: { authorization: `Bearer ${admin}` } })).json()) as { secret: string }).secret;
    const current = await read("GET");
    expect(current).toBe(store.webhookSecret(acme));
    expect(await read("POST")).not.toBe(current);
  });

  it("keeps workspaces apart", async () => {
    const client = await mcpClient(`/w/${other}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("render_survey");
    expect(names).not.toContain("render_rating");
    expect(names).not.toContain("use_recipe");
  });

  it("stops serving when hosting is turned off", async () => {
    store.setHosted(other, false);
    const res = await fetch(`${base}/w/${other}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("upstream for a company's own server (server token)", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("turns data tools on: tool-backed fields, submit tools and recipe submits work", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`, bearer(store.createToken(acme, "server", "acme-mcp")));
    const description = (await client.listTools()).tools.find((t) => t.name === "render_form")?.description;
    expect(description).toContain("resource_select");

    const withSubmit = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "email", label: "Email", type: "email" }], submit: { toolName: "create_lead" } },
    });
    expect(withSubmit.isError).toBeFalsy();
    const recipe = await client.callTool({ name: "use_recipe", arguments: { recipe: "add_item" } });
    expect(recipe._meta?.["genui/form"]).toMatchObject({ submit: { toolName: "create_item" } });
  });

  it("serves private workspaces", async () => {
    const solo = store.createWorkspace("Solo");
    store.setHosted(solo, false);
    store.publish(solo, component("poll", "1.0.0"), html("poll v1"));
    expect((await fetch(`${base}/w/${solo}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);

    const client = await mcpClient(`/w/${solo}/mcp`, bearer(store.createToken(solo, "server", "solo-mcp")));
    expect(client.getServerVersion()?.name).toBe("Solo");
    expect(await resourceText(client, "render_poll")).toBe(html("poll v1"));
  });

  it("picks the environment from the URL only", async () => {
    const token = store.createToken(acme, "server", "environments");
    expect(await resourceText(await mcpClient(`/w/${acme}/mcp`, bearer(token)), "render_rating")).toBe(html("rating v1"));
    expect(await resourceText(await mcpClient(`/w/${acme}/prod/mcp`, bearer(token)), "render_rating")).toBe(html("rating v1"));
    expect(await resourceText(await mcpClient(`/w/${acme}/staging/mcp`, bearer(token)), "render_rating_staging")).toBe(html("rating v1.1"));
    // The old channel header does nothing.
    expect(await resourceText(await mcpClient(`/w/${acme}/mcp`, { ...bearer(token), "x-genui-channel": "staging" }), "render_rating")).toBe(html("rating v1"));
  });

  it("keeps every component version readable for old messages", async () => {
    const token = store.createToken(acme, "server", "versions");
    const staging = await mcpClient(`/w/${acme}/staging/mcp`, bearer(token));
    const stagingUri = ((await staging.listTools()).tools.find((t) => t.name === "render_rating_staging")?._meta as { ui: { resourceUri: string } }).ui.resourceUri;

    // Prod serves 1.0.0, yet still reads the 1.1.0 bundle by its hash.
    const prod = await mcpClient(`/w/${acme}/mcp`, bearer(token));
    expect(((await prod.readResource({ uri: stagingUri })).contents[0] as { text?: string }).text).toBe(html("rating v1.1"));
    await expect(prod.readResource({ uri: "ui://genui/c/rating/0000000000000000" })).rejects.toThrow();
  });

  it("rejects bad tokens, other workspaces' tokens and non-server scopes", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/w/${acme}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await post(bearer("gnu_server_nope"))).status).toBe(401);
    expect((await post(bearer(store.createToken(other, "server", "other-mcp")))).status).toBe(403);
    expect((await post(bearer(store.createToken(acme, "publish", "ci")))).status).toBe(403);
  });
});
