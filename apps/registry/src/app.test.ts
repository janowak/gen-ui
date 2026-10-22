import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createRegistryApp, openDatabase } from "./app.js";

const HTML = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const manifest = (version: string, props: Record<string, unknown> = { type: "object", properties: { question: { type: "string" } } }) => ({
  name: "rating",
  version,
  description: "Ask the user for a star rating.",
  props,
});

let server: ServerType;
let base: string;
let admin: string;
let publisher: string;
let releaser: string;
let reader: string;
let otherReader: string;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // bundles are HTML
  }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  const { app, store } = createRegistryApp(openDatabase(":memory:"));
  const ws = store.createWorkspace("acme");
  admin = store.createToken(ws, "admin", "test");
  publisher = store.createToken(ws, "publish", "ci");
  releaser = store.createToken(ws, "release", "ci-release");
  reader = store.createToken(ws, "server", "sdk");
  otherReader = store.createToken(store.createWorkspace("other"), "server", "sdk");
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("registry", () => {
  it("rejects missing and under-scoped tokens", async () => {
    expect((await call("GET", "/v1/catalog", "nope")).status).toBe(401);
    expect((await call("POST", "/v1/components", reader, { manifest: manifest("1.0.0"), html: HTML("v1") })).status).toBe(403);
    expect((await call("POST", "/v1/components/rating/promote", publisher, {})).status).toBe(403);
  });

  it("publishes to beta, promotes to stable, serves bundles by hash", async () => {
    const published = await call("POST", "/v1/components", publisher, { manifest: manifest("1.0.0"), html: HTML("v1") });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ version: "1.0.0", channel: "beta" });

    expect((await call("GET", "/v1/catalog?channel=stable", reader)).body.components).toEqual([]);
    const beta = await call("GET", "/v1/catalog?channel=beta", reader);
    expect(beta.body.components[0]).toMatchObject({ name: "rating", version: "1.0.0", hash: published.body.hash });

    expect((await call("POST", "/v1/components/rating/promote", admin, {})).body.version).toBe("1.0.0");
    const stable = await call("GET", "/v1/catalog?channel=stable", reader);
    expect(stable.body.components[0].version).toBe("1.0.0");

    const bundle = await call("GET", `/v1/bundles/${published.body.hash}`, reader);
    expect(bundle.body).toContain("v1");
  });

  it("keeps versions immutable and increasing", async () => {
    expect((await call("POST", "/v1/components", publisher, { manifest: manifest("1.0.0"), html: HTML("again") })).status).toBe(409);
    expect((await call("POST", "/v1/components", publisher, { manifest: manifest("0.9.0"), html: HTML("older") })).status).toBe(409);
  });

  it("requires a major bump for breaking props changes", async () => {
    const breaking = manifest("1.1.0", { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] });
    const rejected = await call("POST", "/v1/components", publisher, { manifest: breaking, html: HTML("v1.1") });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toContain('removed prop "question"');

    const major = await call("POST", "/v1/components", publisher, { manifest: { ...breaking, version: "2.0.0" }, html: HTML("v2") });
    expect(major.status).toBe(201);
  });

  it("rolls stable back to the previous version", async () => {
    expect((await call("POST", "/v1/components/rating/promote", admin, {})).body.version).toBe("2.0.0");
    const rolled = await call("POST", "/v1/components/rating/rollback", admin, { channel: "stable" });
    expect(rolled.body.version).toBe("1.0.0");
    expect((await call("GET", "/v1/catalog?channel=stable", reader)).body.components[0].version).toBe("1.0.0");
    expect((await call("POST", "/v1/components/rating/rollback", admin, { channel: "stable" })).status).toBe(409);
  });

  it("stores the theme and isolates workspaces", async () => {
    const theme = { light: { primary: "#4f46e5" } };
    expect((await call("PUT", "/v1/theme", admin, { theme })).status).toBe(200);
    expect((await call("GET", "/v1/catalog", reader)).body.theme).toEqual(theme);

    const other = await call("GET", "/v1/catalog?channel=beta", otherReader);
    expect(other.body).toEqual({ channel: "beta", theme: null, components: [], recipes: [] });
    const hash = (await call("GET", "/v1/catalog?channel=beta", reader)).body.components[0].hash;
    expect((await call("GET", `/v1/bundles/${hash}`, otherReader)).status).toBe(404);
  });

  it("lists components with their channels", async () => {
    const list = await call("GET", "/v1/components", reader);
    expect(list.body.components).toEqual([{ name: "rating", channels: { beta: "2.0.0", stable: "1.0.0" }, versions: ["2.0.0", "1.0.0"] }]);
  });
});

describe("invites", () => {
  it("lets admins invite people by email", async () => {
    expect((await call("POST", "/v1/invites", reader, { email: "x@acme.test" })).status).toBe(403);
    const invited = await call("POST", "/v1/invites", admin, { email: "Carol@Acme.test", role: "admin" });
    expect(invited).toEqual({ status: 201, body: { email: "Carol@Acme.test", role: "admin" } });
  });
});

describe("recipes", () => {
  const recipe = {
    when: "The user wants to add an item.",
    form: { fields: [{ name: "name", label: "Name", type: "text", required: true }], submit: { toolName: "create_item" } },
  };

  it("saves, lists in the catalog, replaces and deletes recipes", async () => {
    expect((await call("PUT", "/v1/recipes/add_item", publisher, recipe)).status).toBe(403);
    expect((await call("PUT", "/v1/recipes/add_item", admin, recipe)).status).toBe(201);
    expect((await call("PUT", "/v1/recipes/add_item", admin, { ...recipe, notes: "Pre-fill the name." })).body).toEqual({ name: "add_item", replaced: true });
    expect((await call("PUT", "/v1/recipes/Bad Name", admin, recipe)).status).toBe(400);

    const catalog = await call("GET", "/v1/catalog", reader);
    expect(catalog.body.recipes).toEqual([{ name: "add_item", ...recipe, notes: "Pre-fill the name." }]);

    expect((await call("DELETE", "/v1/recipes/add_item", admin)).status).toBe(200);
    expect((await call("DELETE", "/v1/recipes/add_item", admin)).status).toBe(404);
  });

  it("accepts only public https validation webhooks", async () => {
    const internal = await call("PUT", "/v1/recipes/quote", admin, { ...recipe, validate: { url: "https://169.254.169.254/latest" } });
    expect(internal.status).toBe(400);
    expect(internal.body.error).toMatch(/public address/);
    expect((await call("PUT", "/v1/recipes/quote", admin, { ...recipe, validate: { url: "http://hooks.acme.com/validate" } })).status).toBe(400);
    expect((await call("PUT", "/v1/recipes/quote", admin, { ...recipe, validate: { url: "https://hooks.acme.com/validate" } })).status).toBe(201);
    expect((await call("DELETE", "/v1/recipes/quote", admin)).status).toBe(200);
  });
});

describe("CI releases", () => {
  const nps = (version: string) => ({ ...manifest(version), name: "nps" });
  const publish = (token: string, version: string, html: string, channel?: string) =>
    call("POST", "/v1/components", token, { manifest: nps(version), html: HTML(html), channel });

  it("lets only release and admin tokens publish to stable", async () => {
    expect(await publish(publisher, "1.0.0", "nps", "stable")).toEqual({ status: 403, body: { error: "Requires a release token (got publish)" } });
    expect((await call("POST", "/v1/tokens", releaser, { scope: "admin", name: "escalate" })).status).toBe(403);
    expect((await call("PUT", "/v1/theme", releaser, { theme: null })).status).toBe(403);
  });

  it("publishes straight to stable, moving beta along", async () => {
    expect(await publish(releaser, "1.0.0", "nps", "stable")).toMatchObject({
      status: 201,
      body: { version: "1.0.0", created: true, channel: "stable", channels: { beta: "1.0.0", stable: "1.0.0" } },
    });
  });

  it("treats re-publishing the same version and content as a no-op", async () => {
    const first = await publish(publisher, "1.1.0", "nps 1.1");
    expect(first.status).toBe(201);
    expect(await publish(publisher, "1.1.0", "nps 1.1")).toMatchObject({
      status: 200,
      body: { created: false, hash: first.body.hash, channels: { beta: "1.1.0", stable: "1.0.0" } },
    });
    expect((await publish(publisher, "1.1.0", "nps 1.1 changed")).status).toBe(409);
    const manifestChanged = await call("POST", "/v1/components", publisher, { manifest: { ...nps("1.1.0"), description: "Changed." }, html: HTML("nps 1.1") });
    expect(manifestChanged.status).toBe(409);
  });

  it("releases an already published version without moving any channel back", async () => {
    expect((await publish(publisher, "1.2.0", "nps 1.2")).status).toBe(201);
    expect((await publish(releaser, "1.1.0", "nps 1.1", "stable")).body).toMatchObject({ created: false, channels: { beta: "1.2.0", stable: "1.1.0" } });
    // Re-running an older release job leaves stable where it is.
    expect((await publish(releaser, "1.0.0", "nps", "stable")).body.channels).toEqual({ beta: "1.2.0", stable: "1.1.0" });
  });

  it("promotes and rolls back with a release token", async () => {
    expect((await call("POST", "/v1/components/nps/promote", releaser, { version: "1.2.0" })).body.version).toBe("1.2.0");
    expect((await call("POST", "/v1/components/nps/rollback", releaser, { channel: "stable" })).body.version).toBe("1.1.0");
  });
});
