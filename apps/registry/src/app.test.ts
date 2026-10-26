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
let workspace: string;
let admin: string;
let publisher: string;
let previewer: string;
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

const publish = (token: string, version: string, html: string, environment?: string, props?: Record<string, unknown>) =>
  call("POST", "/v1/components", token, { manifest: manifest(version, props), html: HTML(html), environment });
const deploy = (token: string, name: string, version: string, environment: string) =>
  call("PUT", `/v1/components/${name}/environments/${environment}`, token, { version });
const environments = async () => (await call("GET", "/v1/components", reader)).body.components[0].environments;

beforeAll(async () => {
  const { app, store } = createRegistryApp(openDatabase(":memory:"));
  workspace = store.createWorkspace("acme");
  store.createEnvironment(workspace, "staging");
  admin = store.createToken(workspace, "admin", "test");
  publisher = store.createToken(workspace, "publish", "ci");
  previewer = store.createToken(workspace, "publish", "ci-preview", ["staging"]);
  reader = store.createToken(workspace, "server", "sdk");
  otherReader = store.createToken(store.createWorkspace("other"), "server", "sdk");
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("publishing to environments", () => {
  it("rejects missing and under-scoped tokens", async () => {
    expect((await call("GET", "/v1/components", "nope")).status).toBe(401);
    expect((await publish(reader, "1.0.0", "v1")).status).toBe(403);
    expect((await deploy(reader, "rating", "1.0.0", "prod")).status).toBe(403);
  });

  it("publishes to prod by default", async () => {
    const published = await publish(publisher, "1.0.0", "v1");
    expect(published.status).toBe(201);
    expect(published.body).toEqual({
      version: "1.0.0",
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      created: true,
      environment: "prod",
      environments: { prod: "1.0.0" },
      warnings: [],
    });
  });

  it("publishes to another environment without touching prod", async () => {
    const published = await publish(publisher, "1.1.0", "v1.1", "staging");
    expect(published.body).toMatchObject({ environment: "staging", environments: { prod: "1.0.0", staging: "1.1.0" } });
  });

  it("fails for an environment that doesn't exist, saying how to create it", async () => {
    const typo = await publish(publisher, "1.1.0", "v1.1", "stagng");
    expect(typo.status).toBe(404);
    expect(typo.body.error).toContain("genui env add stagng");
  });

  it("treats re-publishing the same version and content as a no-op", async () => {
    expect(await publish(publisher, "1.1.0", "v1.1", "staging")).toMatchObject({ status: 200, body: { created: false, environments: { staging: "1.1.0" } } });
    const changed = await publish(publisher, "1.1.0", "v1.1 rebuilt", "prod");
    expect(changed.status).toBe(409);
    expect(changed.body.error).toContain("genui publish rating@1.1.0 --env prod");
    expect((await call("POST", "/v1/components", publisher, { manifest: { ...manifest("1.1.0"), description: "Changed." }, html: HTML("v1.1") })).status).toBe(409);
  });

  it("serves exactly what was last published, older versions included", async () => {
    expect((await publish(publisher, "0.9.0", "v0.9")).body.environments).toEqual({ prod: "0.9.0", staging: "1.1.0" });
    // Going back is publishing the version again.
    expect((await publish(publisher, "1.0.0", "v1")).body.environments).toEqual({ prod: "1.0.0", staging: "1.1.0" });
  });

  it("deploys a published version to another environment without the bundle", async () => {
    const deployed = await deploy(publisher, "rating", "1.1.0", "prod");
    expect(deployed).toMatchObject({ status: 200, body: { version: "1.1.0", created: false, environment: "prod", environments: { prod: "1.1.0", staging: "1.1.0" } } });
    expect((await deploy(publisher, "rating", "3.0.0", "prod")).status).toBe(404);
    expect((await deploy(publisher, "nope", "1.0.0", "prod")).status).toBe(404);
    expect((await deploy(publisher, "rating", "1.1.0", "stagng")).status).toBe(404);
  });

  it("warns about breaking props changes instead of rejecting them", async () => {
    const breaking = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
    const published = await publish(publisher, "1.2.0", "v1.2", "staging", breaking);
    expect(published.status).toBe(201);
    expect(published.body.warnings).toEqual(['removed prop "question" (staging served 1.1.0)', 'newly required prop "prompt" (staging served 1.1.0)']);
  });

  it("limits publish tokens to their environments", async () => {
    expect((await publish(previewer, "1.3.0", "v1.3", "staging")).status).toBe(201);
    expect(await publish(previewer, "1.3.0", "v1.3", "prod")).toEqual({ status: 403, body: { error: "This token can't publish to prod (allowed: staging)" } });
    expect((await deploy(previewer, "rating", "1.3.0", "prod")).status).toBe(403);
    expect(await environments()).toEqual({ prod: "1.1.0", staging: "1.3.0" });
  });

  it("lists components with every environment's version", async () => {
    const list = await call("GET", "/v1/components", reader);
    expect(list.body.components).toEqual([
      { name: "rating", environments: { prod: "1.1.0", staging: "1.3.0" }, versions: ["1.3.0", "1.2.0", "1.1.0", "1.0.0", "0.9.0"] },
    ]);
    expect((await call("GET", "/v1/components", otherReader)).body.components).toEqual([]);
  });
});

describe("environments", () => {
  it("lists them, prod first, with their end-user MCP paths and refresh settings", async () => {
    expect((await call("GET", "/v1/environments", reader)).body.environments).toEqual([
      { name: "prod", path: `/w/${workspace}/mcp`, revision: expect.any(Number), refreshUrl: null, lastRefresh: null },
      { name: "staging", path: `/w/${workspace}/staging/mcp`, revision: expect.any(Number), refreshUrl: null, lastRefresh: null },
    ]);
  });

  it("lets admins create and delete them; prod stays", async () => {
    expect((await call("POST", "/v1/environments", publisher, { name: "dev" })).status).toBe(403);
    expect((await call("POST", "/v1/environments", admin, { name: "Dev!" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", admin, { name: "dev" })).body).toEqual({ name: "dev", path: `/w/${workspace}/dev/mcp` });
    expect((await call("POST", "/v1/environments", admin, { name: "dev" })).status).toBe(409);

    expect((await publish(publisher, "1.3.0", "v1.3", "dev")).status).toBe(200);
    expect((await call("DELETE", "/v1/environments/dev", admin)).status).toBe(200);
    expect(await environments()).toEqual({ prod: "1.1.0", staging: "1.3.0" });
    expect((await call("DELETE", "/v1/environments/prod", admin)).status).toBe(400);
    expect((await call("DELETE", "/v1/environments/dev", admin)).status).toBe(404);
  });
});

describe("tokens", () => {
  it("limits only publish tokens, and only to environments that exist", async () => {
    const limited = await call("POST", "/v1/tokens", admin, { scope: "publish", name: "ci-staging", environments: ["staging"] });
    expect(limited).toMatchObject({ status: 201, body: { scope: "publish", environments: ["staging"] } });
    expect((await call("POST", "/v1/tokens", admin, { scope: "server", name: "sdk", environments: ["staging"] })).status).toBe(400);
    expect((await call("POST", "/v1/tokens", admin, { scope: "publish", name: "ci", environments: ["qa"] })).status).toBe(404);
    expect((await call("POST", "/v1/tokens", publisher, { scope: "admin", name: "escalate" })).status).toBe(403);
  });
});

describe("theme", () => {
  it("is saved per environment and isolated per workspace", async () => {
    const theme = { light: { primary: "#4f46e5" } };
    expect((await call("PUT", "/v1/theme", publisher, { theme: null })).status).toBe(403);
    expect((await call("PUT", "/v1/theme?environment=staging", admin, { theme })).body).toEqual({ environment: "staging", theme });
    expect((await call("GET", "/v1/theme?environment=staging", reader)).body.theme).toEqual(theme);
    expect((await call("GET", "/v1/theme", reader)).body.theme).toBeNull();
    expect((await call("GET", "/v1/theme?environment=qa", reader)).status).toBe(404);
    expect((await call("GET", "/v1/theme?environment=staging", otherReader)).status).toBe(404);
  });
});

describe("invites", () => {
  it("lets admins invite people by email", async () => {
    expect((await call("POST", "/v1/invites", reader, { email: "x@acme.test" })).status).toBe(403);
    const invited = await call("POST", "/v1/invites", admin, { email: "Carol@Acme.test", role: "admin" });
    expect(invited).toEqual({ status: 201, body: { email: "Carol@Acme.test", role: "admin" } });
  });
});

describe("sign-up gate", () => {
  const hosted = { mode: "hosted" as const, adminEmails: [], allowedEmails: ["ann@acme.test", "@partner.test"] };
  const person = (id: string, email: string, emailVerified = true) => ({ id, email, emailVerified, name: id });

  it("gives workspaces only to listed verified emails and domains", () => {
    const { store } = createRegistryApp(openDatabase(":memory:"));
    expect(store.resolveMembership(person("ann", "Ann@Acme.test"), hosted)?.role).toBe("admin");
    expect(store.resolveMembership(person("pat", "pat@partner.test"), hosted)?.role).toBe("admin");
    expect(store.resolveMembership(person("eve", "eve@evil.test"), hosted)).toBeUndefined();
    expect(store.resolveMembership(person("pet", "pat@notpartner.test"), hosted)).toBeUndefined();
    // Unverified emails can't claim a listed address.
    expect(store.resolveMembership(person("fake", "ann@acme.test", false), hosted)).toBeUndefined();
    expect(store.countWorkspaces()).toBe(2);
  });

  it("lets invited people and existing members in", () => {
    const { store } = createRegistryApp(openDatabase(":memory:"));
    const ann = store.resolveMembership(person("ann", "ann@acme.test"), hosted)!;
    // Refused once, then invited: the next sign-in joins the inviting workspace.
    expect(store.resolveMembership(person("bob", "bob@other.test"), hosted)).toBeUndefined();
    store.invite(ann.workspaceId, "bob@other.test", "member");
    expect(store.resolveMembership(person("bob", "bob@other.test"), hosted)).toMatchObject({ workspaceId: ann.workspaceId, role: "member" });
    // Narrowing the list later doesn't lock out members.
    expect(store.resolveMembership(person("ann", "ann@acme.test"), { ...hosted, allowedEmails: ["@nobody.test"] })?.workspaceId).toBe(ann.workspaceId);
  });

  it("lets listed admins into a self-hosted workspace; no list lets everyone in", () => {
    const { store } = createRegistryApp(openDatabase(":memory:"));
    store.createWorkspace("default");
    const selfHosted = { mode: "self-hosted" as const, adminEmails: ["root@acme.test"], allowedEmails: ["@acme.test"] };
    expect(store.resolveMembership(person("root", "root@acme.test"), { ...selfHosted, allowedEmails: ["@elsewhere.test"] })?.role).toBe("admin");
    expect(store.resolveMembership(person("eve", "eve@evil.test"), selfHosted)).toBeUndefined();
    expect(store.resolveMembership(person("eve", "eve@evil.test"), { ...selfHosted, allowedEmails: [] })?.role).toBe("member");
  });
});

describe("recipes", () => {
  const recipe = {
    when: "The user wants to add an item.",
    form: { fields: [{ name: "name", label: "Name", type: "text", required: true }], submit: { toolName: "create_item" } },
  };

  it("saves, lists, replaces and deletes recipes", async () => {
    expect((await call("PUT", "/v1/recipes/add_item", publisher, recipe)).status).toBe(403);
    expect((await call("PUT", "/v1/recipes/add_item", admin, recipe)).status).toBe(201);
    expect((await call("PUT", "/v1/recipes/add_item", admin, { ...recipe, notes: "Pre-fill the name." })).body).toEqual({
      name: "add_item",
      environment: "prod",
      replaced: true,
    });
    expect((await call("PUT", "/v1/recipes/Bad Name", admin, recipe)).status).toBe(400);

    const listed = await call("GET", "/v1/recipes", reader);
    expect(listed.body.recipes).toEqual([{ name: "add_item", ...recipe, notes: "Pre-fill the name." }]);

    expect((await call("DELETE", "/v1/recipes/add_item", admin)).status).toBe(200);
    expect((await call("DELETE", "/v1/recipes/add_item", admin)).status).toBe(404);
  });

  it("keeps each environment's recipes apart", async () => {
    expect((await call("PUT", "/v1/recipes/add_item?environment=staging", admin, recipe)).body).toMatchObject({ environment: "staging" });
    expect((await call("GET", "/v1/recipes?environment=staging", reader)).body.recipes.map((r: { name: string }) => r.name)).toEqual(["add_item"]);
    expect((await call("GET", "/v1/recipes", reader)).body.recipes).toEqual([]);
    expect((await call("PUT", "/v1/recipes/add_item?environment=qa", admin, recipe)).status).toBe(404);
    expect((await call("DELETE", "/v1/recipes/add_item?environment=staging", admin)).status).toBe(200);
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
