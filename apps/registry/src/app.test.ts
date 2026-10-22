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
    expect(other.body).toEqual({ channel: "beta", theme: null, components: [] });
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
