import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe, type Served } from "./serve.js";

const manifest = {
  name: "rating",
  description: "Ask the user to rate something.",
  props: { type: "object", properties: { question: { type: "string" } } },
};

describe("startServe", () => {
  let dir: string;
  let served: Served | undefined;
  const clients: Client[] = [];
  const logs: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "genui-serve-"));
    logs.length = 0;
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await served?.close();
    served = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (path: string, content: unknown) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  const component = async (version: string) => {
    await write("rating/dist/genui.component.json", { ...manifest, version, bundle: "index.html" });
    await write("rating/dist/index.html", `<p>rating ${version}</p>`);
  };
  const start = async (options: Partial<Parameters<typeof startServe>[0]> = {}) => {
    served = await startServe({ dirs: [join(dir, "rating")], port: 0, log: (line) => logs.push(line), ...options });
    return served;
  };
  const connect = async (url: string, token?: string) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    clients.push(client);
    return client;
  };
  const uriOf = async (client: Client, tool: string) =>
    ((await client.listTools()).tools.find((t) => t.name === tool)?._meta?.ui as { resourceUri: string } | undefined)?.resourceUri;
  const submitForm = { title: "Signup", fields: [{ name: "email", label: "Email", type: "email" }], submit: { toolName: "create_signup" } };

  it("serves built-in views and local components at /mcp, rendering only without a token", async () => {
    await component("1.0.0");
    const { url } = await start();
    const client = await connect(url!);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["render_chart", "render_form", "render_rating"]);
    const uri = (await uriOf(client, "render_rating"))!;
    expect((await client.readResource({ uri })).contents[0]).toMatchObject({ text: "<p>rating 1.0.0</p>" });

    const direct = await client.callTool({ name: "render_form", arguments: submitForm });
    expect(direct.isError).toBe(true);
  });

  it("turns data tools on for @app-mcp/sdk, which sends a token", async () => {
    await component("1.0.0");
    const { url } = await start();
    const sdk = await connect(url!, "local");
    const result = await sdk.callTool({ name: "render_form", arguments: submitForm });
    expect(result.isError).toBeFalsy();
  });

  it("reloads on change: new bundle URI, list_changed to connected clients, revision bumped, old version kept", async () => {
    await component("1.0.0");
    const { url } = await start();
    const client = await connect(url!);
    const before = (await uriOf(client, "render_rating"))!;
    const revisionUrl = url!.replace(/\/mcp$/, "/revision");
    expect(await (await fetch(revisionUrl)).json()).toEqual({ revision: 1 });

    const changed = new Promise<void>((resolve) => client.setNotificationHandler("notifications/tools/list_changed", () => resolve()));
    await component("1.0.1");
    await changed;
    await expect.poll(() => uriOf(client, "render_rating")).not.toBe(before);
    expect(await (await fetch(revisionUrl)).json()).toEqual({ revision: 2 });
    expect(logs.some((line) => line.startsWith("rating@1.0.1 reloaded"))).toBe(true);
    expect((await client.readResource({ uri: before })).contents[0]).toMatchObject({ text: "<p>rating 1.0.0</p>" });
  });

  it("answers the revision with an ETag, as the registry does for @app-mcp/sdk", async () => {
    await component("1.0.0");
    const { url } = await start();
    const revisionUrl = url!.replace(/\/mcp$/, "/revision");
    const first = await fetch(revisionUrl);
    const etag = first.headers.get("etag")!;
    expect((await fetch(revisionUrl, { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  it("refuses other Host names, so a web page can't reach it through DNS rebinding", async () => {
    await component("1.0.0");
    const { url } = await start();
    const response = await served!.mcp.fetch(new Request(url!.replace("localhost", "evil.example"), { method: "POST" }));
    expect(response.status).toBe(403);
  });

  it("keeps serving when a component doesn't load, and picks it up once built", async () => {
    await mkdir(join(dir, "rating"));
    const { url } = await start();
    expect(logs).toEqual([expect.stringContaining("no genui.component.json")]);
    const client = await connect(url!);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("render_rating");

    await component("1.0.0");
    await expect.poll(async () => (await client.listTools()).tools.map((t) => t.name), { timeout: 3000 }).toContain("render_rating");
  });
});
