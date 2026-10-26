import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistryApp, type Store } from "./app.js";
import { loadAssets, testDatabase } from "./testing.js";

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

const addItem = {
  name: "add_item",
  description: "The user wants to add an item.",
  instructions: "Show a form with the name and submit to create_item.",
  params: [{ name: "name", description: "Item name", required: false }],
};
const feedback = {
  name: "feedback",
  description: "After an item is added.",
  instructions: "Ask for a rating with render_rating.",
  params: [],
};

async function mcpClient(path: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), headers && { requestInit: { headers } }));
  return client;
}

async function resourceText(client: Client, tool: string): Promise<string | undefined> {
  const { tools } = await client.listTools();
  const uri = (tools.find((t) => t.name === tool)!._meta as { ui: { resourceUri: string } }).ui.resourceUri;
  return ((await client.readResource({ uri })).contents[0] as { text?: string }).text;
}

beforeAll(async () => {
  const created = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
  store = created.store;
  acme = await store.createWorkspace("Acme");
  await store.createEnvironment(acme, "staging");
  admin = await store.createToken(acme, "admin", "test");
  await store.publish(acme, component("rating", "1.0.0"), html("rating v1"));
  await store.publish(acme, component("rating", "1.1.0"), html("rating v1.1"), "staging");
  await store.setTheme(acme, "prod", { light: { primary: "#16a34a" } });
  await store.saveWorkflow(acme, "prod", addItem);
  await store.saveWorkflow(acme, "prod", feedback);

  other = await store.createWorkspace("Other");
  await store.publish(other, component("survey", "1.0.0"), html("survey"));

  server = serve({ fetch: created.app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
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

  it("serves the workspace's render tools, components and workflows, with no admin tools", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`);
    expect(client.getServerVersion()?.name).toBe("Acme");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["render_form", "render_chart", "render_rating"]));
    expect(names.some((n) => n.startsWith("preview_") || n.startsWith("component_") || n.startsWith("theme_"))).toBe(false);
    expect(names).not.toContain("render_survey");
    // The command workflow is a prompt; the other one is in the instructions.
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["add_item"]);
    expect(client.getInstructions()).toContain("### feedback\nWhen: After an item is added.");

    // Prod serves what was published to prod, with prod's theme and no preview flag.
    expect(await resourceText(client, "render_rating")).toBe(html("rating v1"));
    const rendered = await client.callTool({ name: "render_rating", arguments: { question: "How was it?" } });
    expect(rendered._meta).toMatchObject({ "genui/theme": { light: { primary: "#16a34a" } } });
    expect(rendered._meta).not.toHaveProperty("genui/preview");
  });

  it("serves another environment at its own address, with suffixed names and its own workflows", async () => {
    const client = await mcpClient(`/w/${acme}/staging/mcp`);
    expect(client.getServerVersion()?.name).toBe("Acme (staging)");
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["render_chart_staging", "render_form_staging", "render_rating_staging"]);
    expect(tools.find((t) => t.name === "render_form_staging")?.title).toBe("Show form (staging)");
    expect(await resourceText(client, "render_rating_staging")).toBe(html("rating v1.1"));
    // Staging has no workflows or theme of its own yet: prod's don't leak in.
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(client.getInstructions()).toBeUndefined();
    const rendered = await client.callTool({ name: "render_rating_staging", arguments: { question: "How was it?" } });
    expect(rendered._meta).not.toHaveProperty("genui/theme");

    await store.saveWorkflow(acme, "staging", addItem);
    const again = await mcpClient(`/w/${acme}/staging/mcp`);
    expect((await again.listPrompts()).prompts.map((p) => [p.name, p.title])).toEqual([["add_item_staging", "add_item (staging)"]]);
    expect((await again.getPrompt({ name: "add_item_staging", arguments: { name: "Mug" } })).messages[0]?.content).toEqual({
      type: "text",
      text: `${addItem.instructions}\n\nname: Mug`,
    });
  });

  it("leaves out the built-in form and chart, and components it stopped serving", async () => {
    await store.createEnvironment(acme, "lean");
    await store.deployVersion(acme, "rating", "1.1.0", "lean");
    await store.setBuiltIns(acme, "lean", false);
    expect((await store.catalog(acme, "lean")).builtIns).toBe(false);
    expect((await (await mcpClient(`/w/${acme}/lean/mcp`)).listTools()).tools.map((t) => t.name)).toEqual(["render_rating_lean"]);

    await store.removeComponent(acme, "rating", "lean");
    expect((await (await mcpClient(`/w/${acme}/lean/mcp`)).listTools()).tools).toEqual([]);
    await expect(store.removeComponent(acme, "rating", "lean")).rejects.toThrow(`lean doesn't serve "rating"`);
    // Its versions stay published: serving one again needs no rebuild.
    expect((await store.deployVersion(acme, "rating", "1.1.0", "lean")).environments).toMatchObject({ lean: "1.1.0" });
    await store.deleteEnvironment(acme, "lean");
  });

  it("answers 404 for an environment that doesn't exist", async () => {
    const res = await fetch(`${base}/w/${acme}/stagng/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No environment "stagng" in this workspace.' });
  });

  it("renders inline data only; form values go back to the conversation", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`);
    const withSubmit = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "email", label: "Email", type: "email" }], submit: { toolName: "create_lead" } },
    });
    expect(withSubmit.isError).toBe(true);

    const inline = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "email", label: "Email", type: "email" }] },
    });
    expect(inline.isError).toBeFalsy();
  });

  it("keeps workspaces apart", async () => {
    const client = await mcpClient(`/w/${other}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("render_survey");
    expect(names).not.toContain("render_rating");
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });

  it("stops serving when hosting is turned off", async () => {
    await store.setHosted(other, false);
    const res = await fetch(`${base}/w/${other}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("upstream for a company's own server (server token)", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("turns data tools on: tool-backed fields and submit tools work", async () => {
    const client = await mcpClient(`/w/${acme}/mcp`, bearer(await store.createToken(acme, "server", "acme-mcp")));
    const description = (await client.listTools()).tools.find((t) => t.name === "render_form")?.description;
    expect(description).toContain("resource_select");

    const withSubmit = await client.callTool({
      name: "render_form",
      arguments: { fields: [{ name: "email", label: "Email", type: "email" }], submit: { toolName: "create_lead" } },
    });
    expect(withSubmit.isError).toBeFalsy();
  });

  it("serves private workspaces", async () => {
    const solo = await store.createWorkspace("Solo");
    await store.setHosted(solo, false);
    await store.publish(solo, component("poll", "1.0.0"), html("poll v1"));
    expect(
      (await fetch(`${base}/w/${solo}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(404);

    const client = await mcpClient(`/w/${solo}/mcp`, bearer(await store.createToken(solo, "server", "solo-mcp")));
    expect(client.getServerVersion()?.name).toBe("Solo");
    expect(await resourceText(client, "render_poll")).toBe(html("poll v1"));
  });

  it("picks the environment from the URL only", async () => {
    const token = await store.createToken(acme, "server", "environments");
    expect(await resourceText(await mcpClient(`/w/${acme}/mcp`, bearer(token)), "render_rating")).toBe(html("rating v1"));
    expect(await resourceText(await mcpClient(`/w/${acme}/prod/mcp`, bearer(token)), "render_rating")).toBe(html("rating v1"));
    expect(await resourceText(await mcpClient(`/w/${acme}/staging/mcp`, bearer(token)), "render_rating_staging")).toBe(html("rating v1.1"));
    // The old channel header does nothing.
    expect(await resourceText(await mcpClient(`/w/${acme}/mcp`, { ...bearer(token), "x-genui-channel": "staging" }), "render_rating")).toBe(
      html("rating v1"),
    );
  });

  it("keeps every component version readable for old messages", async () => {
    const token = await store.createToken(acme, "server", "versions");
    const staging = await mcpClient(`/w/${acme}/staging/mcp`, bearer(token));
    const stagingUri = (
      (await staging.listTools()).tools.find((t) => t.name === "render_rating_staging")!._meta as { ui: { resourceUri: string } }
    ).ui.resourceUri;

    // Prod serves 1.0.0, yet still reads the 1.1.0 bundle by its hash.
    const prod = await mcpClient(`/w/${acme}/mcp`, bearer(token));
    expect(((await prod.readResource({ uri: stagingUri })).contents[0] as { text?: string }).text).toBe(html("rating v1.1"));
    await expect(prod.readResource({ uri: "ui://genui/c/rating/0000000000000000" })).rejects.toThrow();
  });

  it("rejects bad tokens, other workspaces' tokens and non-server scopes", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/w/${acme}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await post(bearer("gnu_server_nope"))).status).toBe(401);
    expect((await post(bearer(await store.createToken(other, "server", "other-mcp")))).status).toBe(403);
    expect((await post(bearer(await store.createToken(acme, "publish", "ci")))).status).toBe(403);
  });
});

describe("branding and instructions", () => {
  // The smallest valid PNG header is enough: the format is read from the bytes.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json",
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
  const instructions = "Acme handles returns. Look the order up with get_order first.";

  afterAll(async () => {
    await store.setBranding(acme, {});
    await store.setIcon(acme, null);
    await store.setInstructions(acme, "prod", null);
  });

  it("presents the workspace's title, description, website and icon to hosts", async () => {
    expect(
      (await call("PUT", "/branding", { title: "Acme Support", description: "Orders and returns.", websiteUrl: "https://acme.test" }))
        .status,
    ).toBe(200);
    expect((await call("PUT", "/branding/icon", new TextEncoder().encode("not an image"))).status).toBe(400);
    const saved = (await (await call("PUT", "/branding/icon", png)).json()) as { icon: { type: string; hash: string } };
    expect(saved.icon.type).toBe("image/png");

    const info = (await mcpClient(`/w/${acme}/mcp`)).getServerVersion();
    expect(info).toMatchObject({
      name: "Acme",
      title: "Acme Support",
      description: "Orders and returns.",
      websiteUrl: "https://acme.test",
    });
    expect(info?.icons).toEqual([{ src: `${base}/w/${acme}/icon?v=${saved.icon.hash}`, mimeType: "image/png" }]);
    expect((await mcpClient(`/w/${acme}/staging/mcp`)).getServerVersion()?.title).toBe("Acme Support (staging)");

    // Hosts fetch the icon without a token, even from a private workspace; the versioned URL caches for good.
    const icon = await fetch(info!.icons![0]!.src);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(png);
    expect((await fetch(`${base}/w/${other}/icon`)).status).toBe(404);
  });

  it("gives each environment its own instructions, with its workflows added", async () => {
    const before = (await store.environment(acme, "prod"))!.revision;
    expect((await call("PUT", "/instructions?environment=prod", { instructions })).status).toBe(200);
    expect((await store.environment(acme, "prod"))!.revision).toBe(before + 1);

    const client = await mcpClient(`/w/${acme}/mcp`);
    expect(client.getInstructions()).toBe(
      `${instructions}\n\n## Workflows\n\nThe user starts these as slash commands:\n- /add_item: ${addItem.description}\n\n### feedback\nWhen: ${feedback.description}\n${feedback.instructions}`,
    );

    // Staging has none of prod's instructions, only its own workflow.
    const staging = await mcpClient(`/w/${acme}/staging/mcp`);
    expect(staging.getInstructions()).not.toContain(instructions);
    expect(await (await call("GET", "/instructions?environment=staging")).json()).toEqual({ environment: "staging", instructions: null });
  });
});
