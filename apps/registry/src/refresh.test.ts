import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRegistryApp, openDatabase, type Refresher, type Store } from "./app.js";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const rating = (version: string) => ({ name: "rating", version, description: "Ask for a star rating.", props: { type: "object", properties: {} }, tools: [] });
const recipe = { name: "add_item", when: "The user wants to add an item.", form: { fields: [{ name: "name", label: "Name", type: "text" as const }] } };

let app: ReturnType<typeof createRegistryApp>["app"];
let store: Store;
let refresher: Refresher;
let acme: string;
let admin: string;
let reader: string;
let otherReader: string;

// The company's server: its refresh endpoint records what genui sent and answers 202, slowly when asked.
let receiver: Server;
let refreshUrl: string;
let received: { environment: string; revision: number; type: string }[] = [];
let delayMs = 0;

function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const revision = (environment = "prod") => store.environment(acme, environment)!.revision;

beforeAll(async () => {
  ({ app, store, refresher } = createRegistryApp(openDatabase(":memory:"), { allowPrivateWebhooks: true }));
  acme = store.createWorkspace("acme");
  store.createEnvironment(acme, "staging");
  admin = store.createToken(acme, "admin", "test");
  reader = store.createToken(acme, "server", "sdk");
  otherReader = store.createToken(store.createWorkspace("other"), "server", "sdk");

  receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push(JSON.parse(raw));
      setTimeout(() => res.writeHead(202).end(), delayMs);
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  refreshUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/genui/refresh`;
});

afterAll(() => receiver.close());

beforeEach(async () => {
  await refresher.idle();
  received = [];
  delayMs = 0;
});

describe("revisions", () => {
  it("bump on every change to what an environment serves, not on a re-run publish", () => {
    const start = revision();
    store.publish(acme, rating("1.0.0"), html("v1"));
    expect(revision()).toBe(start + 1);
    store.publish(acme, rating("1.0.0"), html("v1")); // CI re-run: prod already serves it
    expect(revision()).toBe(start + 1);
    expect(() => store.publish(acme, rating("1.0.0"), html("changed"))).toThrow(/immutable/);
    expect(revision()).toBe(start + 1);

    const staging = revision("staging");
    store.deployVersion(acme, "rating", "1.0.0", "staging");
    expect(revision("staging")).toBe(staging + 1);
    expect(revision()).toBe(start + 1);

    store.setTheme(acme, "prod", { light: { primary: "#16a34a" } });
    store.saveRecipe(acme, "prod", recipe);
    store.deleteRecipe(acme, "prod", recipe.name);
    expect(revision()).toBe(start + 4);
  });

  it("are served next to the MCP, with an ETag", async () => {
    const res = await call("GET", `/w/${acme}/revision`, reader);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: revision() });
    const etag = res.headers.get("etag")!;
    expect((await call("GET", `/w/${acme}/revision`, reader, undefined, { "if-none-match": etag })).status).toBe(304);
    expect(await (await call("GET", `/w/${acme}/staging/revision`, reader)).json()).toEqual({ revision: revision("staging") });

    expect((await call("GET", `/w/${acme}/revision`, otherReader)).status).toBe(403);
    expect((await call("GET", `/w/${acme}/nope/revision`, reader)).status).toBe(404);
    // Without a token only public workspaces answer, like their MCP.
    expect((await call("GET", `/w/${acme}/revision`)).status).toBe(200);
    store.setHosted(acme, false);
    expect((await call("GET", `/w/${acme}/revision`)).status).toBe(404);
    store.setHosted(acme, true);
  });
});

describe("refresh URLs", () => {
  it("are called after every change to their environment, with its revision", async () => {
    const set = await call("PUT", "/v1/environments/prod", admin, { refreshUrl });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ name: "prod", refreshUrl, lastRefresh: null, path: `/w/${acme}/mcp` });

    const published = await call("POST", "/v1/components", admin, { manifest: rating("1.1.0"), html: html("v1.1") });
    expect(published.status).toBe(201);
    await refresher.idle();
    expect(received).toEqual([{ type: "genui.refresh", environment: "prod", revision: revision() }]);

    // Saves from the registry MCP go through the same store: theme and recipes too.
    store.setTheme(acme, "prod", null);
    await refresher.idle();
    expect(received.at(-1)).toEqual({ type: "genui.refresh", environment: "prod", revision: revision() });

    // Another environment's change doesn't reach prod's server.
    store.deployVersion(acme, "rating", "1.1.0", "staging");
    await refresher.idle();
    expect(received).toHaveLength(2);

    const { environments } = (await (await call("GET", "/v1/environments", reader)).json()) as { environments: { name: string; lastRefresh: unknown }[] };
    expect(environments.find((e) => e.name === "prod")?.lastRefresh).toMatchObject({ ok: true, status: 202 });
  });

  it("send one more call with the latest revision for changes made during a call", async () => {
    delayMs = 50;
    store.saveRecipe(acme, "prod", recipe);
    store.saveRecipe(acme, "prod", { ...recipe, when: "Adding things." });
    store.deleteRecipe(acme, "prod", recipe.name);
    await refresher.idle();
    expect(received).toHaveLength(2);
    expect(received.at(-1)?.revision).toBe(revision());
  });

  it("record a failed call without failing the write", async () => {
    await call("PUT", "/v1/environments/prod", admin, { refreshUrl: "http://127.0.0.1:9/genui/refresh" });
    expect((await call("PUT", "/v1/theme", admin, { theme: { light: { primary: "#000000" } } })).status).toBe(200);
    await refresher.idle();
    expect(store.environment(acme, "prod")?.lastRefresh).toMatchObject({ ok: false, error: expect.any(String) });

    await call("PUT", "/v1/environments/prod", admin, { refreshUrl: null });
    expect(store.environment(acme, "prod")).toMatchObject({ refreshUrl: null, lastRefresh: null });
  });

  it("must be public https unless private webhooks are allowed, and are set by admins", async () => {
    const strict = createRegistryApp(openDatabase(":memory:"));
    const ws = strict.store.createWorkspace("strict");
    const token = strict.store.createToken(ws, "admin", "test");
    const put = (body: unknown, as = token) =>
      strict.app.request("/v1/environments/prod", { method: "PUT", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify(body) });

    expect(await (await put({ refreshUrl: "http://mcp.acme.test/genui/refresh" })).json()).toEqual({ error: "The refresh URL must use https." });
    expect(await (await put({ refreshUrl: "https://127.0.0.1/genui/refresh" })).json()).toEqual({ error: "The refresh URL must be a public address." });
    expect((await put({ refreshUrl: "https://mcp.acme.test/genui/refresh" })).status).toBe(200);
    expect((await put({ refreshUrl: null }, strict.store.createToken(ws, "publish", "ci"))).status).toBe(403);
    expect((await call("PUT", "/v1/environments/nope", admin, { refreshUrl })).status).toBe(404);
  });
});
