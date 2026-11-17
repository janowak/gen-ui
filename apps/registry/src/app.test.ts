import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createRegistryApp } from "./app.js";
import { loadAssets, testDatabase } from "./testing.js";

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
  const { app, store } = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
  workspace = await store.createWorkspace("acme");
  await store.createEnvironment(workspace, "staging");
  admin = await store.createToken(workspace, "admin", "test");
  publisher = await store.createToken(workspace, "publish", "ci");
  previewer = await store.createToken(workspace, "publish", "ci-preview", ["staging"]);
  reader = await store.createToken(workspace, "server", "sdk");
  otherReader = await store.createToken(await store.createWorkspace("other"), "server", "sdk");
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
    expect(typo.body.error).toContain("app-mcp env add stagng");
  });

  it("treats re-publishing the same version and content as a no-op", async () => {
    expect(await publish(publisher, "1.1.0", "v1.1", "staging")).toMatchObject({
      status: 200,
      body: { created: false, environments: { staging: "1.1.0" } },
    });
    const changed = await publish(publisher, "1.1.0", "v1.1 rebuilt", "prod");
    expect(changed.status).toBe(409);
    expect(changed.body.error).toContain("app-mcp publish rating@1.1.0 --env prod");
    expect(
      (await call("POST", "/v1/components", publisher, { manifest: { ...manifest("1.1.0"), description: "Changed." }, html: HTML("v1.1") }))
        .status,
    ).toBe(409);
  });

  it("serves exactly what was last published, older versions included", async () => {
    expect((await publish(publisher, "0.9.0", "v0.9")).body.environments).toEqual({ prod: "0.9.0", staging: "1.1.0" });
    // Going back is publishing the version again.
    expect((await publish(publisher, "1.0.0", "v1")).body.environments).toEqual({ prod: "1.0.0", staging: "1.1.0" });
  });

  it("deploys a published version to another environment without the bundle", async () => {
    const deployed = await deploy(publisher, "rating", "1.1.0", "prod");
    expect(deployed).toMatchObject({
      status: 200,
      body: { version: "1.1.0", created: false, environment: "prod", environments: { prod: "1.1.0", staging: "1.1.0" } },
    });
    expect((await deploy(publisher, "rating", "3.0.0", "prod")).status).toBe(404);
    expect((await deploy(publisher, "nope", "1.0.0", "prod")).status).toBe(404);
    expect((await deploy(publisher, "rating", "1.1.0", "stagng")).status).toBe(404);
  });

  it("warns about breaking props changes instead of rejecting them", async () => {
    const breaking = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
    const published = await publish(publisher, "1.2.0", "v1.2", "staging", breaking);
    expect(published.status).toBe(201);
    expect(published.body.warnings).toEqual([
      'removed prop "question" (staging served 1.1.0)',
      'newly required prop "prompt" (staging served 1.1.0)',
    ]);
  });

  it("limits publish tokens to their environments", async () => {
    expect((await publish(previewer, "1.3.0", "v1.3", "staging")).status).toBe(201);
    expect(await publish(previewer, "1.3.0", "v1.3", "prod")).toEqual({
      status: 403,
      body: { error: "This token can't publish to prod (allowed: staging)" },
    });
    expect((await deploy(previewer, "rating", "1.3.0", "prod")).status).toBe(403);
    expect(await environments()).toEqual({ prod: "1.1.0", staging: "1.3.0" });
  });

  it("lists components with every environment's version", async () => {
    const list = await call("GET", "/v1/components", reader);
    expect(list.body.components).toEqual([
      { name: "rating", environments: { prod: "1.1.0", staging: "1.3.0" }, versions: ["1.3.0", "1.2.0", "1.1.0", "1.0.0", "0.9.0"] },
    ]);
    expect((await call("GET", "/v1/components", otherReader)).body.components).toEqual([]);
    // The publish token CI or a developer published with can see the result.
    expect((await call("GET", "/v1/components", previewer)).status).toBe(200);
  });
});

describe("environments", () => {
  it("lists them, prod first, with their end-user MCP paths and refresh settings", async () => {
    expect((await call("GET", "/v1/environments", reader)).body.environments).toEqual([
      { name: "prod", path: `/w/${workspace}/mcp`, revision: expect.any(Number), refreshUrl: null, lastRefresh: null, builtIns: true },
      {
        name: "staging",
        path: `/w/${workspace}/staging/mcp`,
        revision: expect.any(Number),
        refreshUrl: null,
        lastRefresh: null,
        builtIns: true,
      },
    ]);
  });

  it("lets admins turn the built-in form and chart off, leaving other settings as they are", async () => {
    expect((await call("PUT", "/v1/environments/staging", publisher, { builtIns: false })).status).toBe(403);
    expect((await call("PUT", "/v1/environments/qa", admin, { builtIns: false })).status).toBe(404);
    expect((await call("PUT", "/v1/environments/staging", admin, { builtIns: false })).body).toMatchObject({
      name: "staging",
      builtIns: false,
      refreshUrl: null,
    });
    expect((await call("PUT", "/v1/environments/staging", admin, { builtIns: true })).body).toMatchObject({ builtIns: true });
  });

  it("stops serving a component in an environment; its versions stay", async () => {
    expect((await call("PUT", "/v1/environments/dev", admin, { builtIns: true })).status).toBe(404);
    expect((await call("POST", "/v1/environments", admin, { name: "qa" })).status).toBe(201);
    expect((await deploy(publisher, "rating", "1.0.0", "qa")).status).toBe(200);
    expect((await call("DELETE", "/v1/components/rating/environments/qa", previewer)).status).toBe(403);
    expect((await call("DELETE", "/v1/components/rating/environments/qa", reader)).status).toBe(403);
    expect((await call("DELETE", "/v1/components/rating/environments/qa", publisher)).body).toEqual({
      removed: "rating",
      environment: "qa",
    });
    expect((await call("DELETE", "/v1/components/rating/environments/qa", publisher)).status).toBe(404);
    expect(await environments()).not.toHaveProperty("qa");
    expect((await call("GET", "/v1/components", reader)).body.components[0].versions).toContain("1.0.0");
    expect((await call("DELETE", "/v1/environments/qa", admin)).status).toBe(200);
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

describe("sign-up gate", () => {
  const hosted = { mode: "hosted" as const, adminEmails: [], allowedEmails: ["ann@acme.test", "@partner.test"] };
  const person = (id: string, email: string, emailVerified = true) => ({ id, email, emailVerified, name: id });

  it("gives workspaces only to listed verified emails and domains", async () => {
    const { store } = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
    expect((await store.resolveMembership(person("ann", "Ann@Acme.test"), hosted))?.role).toBe("admin");
    expect((await store.resolveMembership(person("pat", "pat@partner.test"), hosted))?.role).toBe("admin");
    expect(await store.resolveMembership(person("eve", "eve@evil.test"), hosted)).toBeUndefined();
    expect(await store.resolveMembership(person("pet", "pat@notpartner.test"), hosted)).toBeUndefined();
    // Unverified emails can't claim a listed address.
    expect(await store.resolveMembership(person("fake", "ann@acme.test", false), hosted)).toBeUndefined();
    expect(await store.countWorkspaces()).toBe(2);
  });

  it("lets invited people and existing members in", async () => {
    const { store } = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
    const ann = (await store.resolveMembership(person("ann", "ann@acme.test"), hosted))!;
    // Refused once, then invited: the next sign-in joins the inviting workspace.
    expect(await store.resolveMembership(person("bob", "bob@other.test"), hosted)).toBeUndefined();
    await store.invite(ann.workspaceId, "bob@other.test", "member");
    expect(await store.resolveMembership(person("bob", "bob@other.test"), hosted)).toMatchObject({
      workspaceId: ann.workspaceId,
      role: "member",
    });
    // An invite wins over a workspace made at an earlier sign-in; an unused one is deleted.
    const pat = (await store.resolveMembership(person("pat", "pat@partner.test"), hosted))!;
    await store.invite(ann.workspaceId, "pat@partner.test", "admin");
    expect(await store.resolveMembership(person("pat", "pat@partner.test"), hosted)).toMatchObject({
      workspaceId: ann.workspaceId,
      role: "admin",
    });
    expect((await store.resolveMembership(person("pat", "pat@partner.test"), hosted))?.workspaceId).toBe(ann.workspaceId);
    expect(await store.workspace(pat.workspaceId)).toBeUndefined();
    // A workspace in use is kept.
    const zoe = (await store.resolveMembership(person("zoe", "zoe@partner.test"), hosted))!;
    await store.createToken(zoe.workspaceId, "server", "sdk");
    await store.invite(ann.workspaceId, "zoe@partner.test", "member");
    expect((await store.resolveMembership(person("zoe", "zoe@partner.test"), hosted))?.workspaceId).toBe(ann.workspaceId);
    expect(await store.workspace(zoe.workspaceId)).toBeDefined();
    // Narrowing the list later doesn't lock out members.
    expect(
      (await store.resolveMembership(person("ann", "ann@acme.test"), { ...hosted, allowedEmails: ["@nobody.test"] }))?.workspaceId,
    ).toBe(ann.workspaceId);
  });

  it("lets people past the gate make more workspaces and switch between them", async () => {
    const { store } = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
    const ann = (await store.resolveMembership(person("ann", "ann@acme.test"), hosted))!;
    const demo = await store.createOwnWorkspace(person("ann", "ann@acme.test"), "demo", hosted);
    expect(demo).toMatchObject({ role: "admin", environment: "prod" });
    // The new one is active, and stays so at the next sign-in.
    expect((await store.resolveMembership(person("ann", "ann@acme.test"), hosted))?.workspaceId).toBe(demo.workspaceId);
    expect(await store.listWorkspaces("ann")).toEqual([
      { id: demo.workspaceId, name: "demo", role: "admin", active: true },
      { id: ann.workspaceId, name: "ann's workspace", role: "admin", active: false },
    ]);
    await store.switchWorkspace("ann", ann.workspaceId);
    expect((await store.membership("ann"))?.workspaceId).toBe(ann.workspaceId);
    expect((await store.listWorkspaces("ann"))[0]).toMatchObject({ id: ann.workspaceId, active: true });

    // Only into their own workspaces.
    const pat = (await store.resolveMembership(person("pat", "pat@partner.test"), hosted))!;
    await expect(store.switchWorkspace("ann", pat.workspaceId)).rejects.toMatchObject({ status: 404 });

    // The gate decides who may make one, not just the first: members who got in by invite may not.
    await store.invite(ann.workspaceId, "bob@other.test", "member");
    await store.resolveMembership(person("bob", "bob@other.test"), hosted);
    await expect(store.createOwnWorkspace(person("bob", "bob@other.test"), "mine", hosted)).rejects.toMatchObject({ status: 403 });
    await expect(store.createOwnWorkspace(person("fake", "ann@acme.test", false), "mine", hosted)).rejects.toMatchObject({
      status: 403,
    });
    // A self-hosted registry has one workspace.
    await expect(
      store.createOwnWorkspace(person("ann", "ann@acme.test"), "more", { ...hosted, mode: "self-hosted" }),
    ).rejects.toMatchObject({ status: 403 });

    // An invite to someone with several workspaces deletes none of them, even unused ones.
    await store.invite(pat.workspaceId, "ann@acme.test", "member");
    expect((await store.resolveMembership(person("ann", "ann@acme.test"), hosted))?.workspaceId).toBe(pat.workspaceId);
    expect((await store.listWorkspaces("ann")).map((w) => w.name)).toEqual(["pat's workspace", "ann's workspace", "demo"]);
  });

  it("lets listed admins into a self-hosted workspace; no list lets everyone in", async () => {
    const { store } = createRegistryApp(await testDatabase(), { assets: await loadAssets() });
    await store.createWorkspace("default");
    const selfHosted = { mode: "self-hosted" as const, adminEmails: ["root@acme.test"], allowedEmails: ["@acme.test"] };
    expect(
      (await store.resolveMembership(person("root", "root@acme.test"), { ...selfHosted, allowedEmails: ["@elsewhere.test"] }))?.role,
    ).toBe("admin");
    expect(await store.resolveMembership(person("eve", "eve@evil.test"), selfHosted)).toBeUndefined();
    expect((await store.resolveMembership(person("eve", "eve@evil.test"), { ...selfHosted, allowedEmails: [] }))?.role).toBe("member");
  });
});

describe("workflows", () => {
  const workflow = { description: "The user wants to add an item.", instructions: "Show a form with the name and submit to create_item." };

  it("publish tokens save, list, replace and delete workflows, like components", async () => {
    expect((await call("PUT", "/v1/workflows/add_item", reader, workflow)).status).toBe(403);
    expect((await call("PUT", "/v1/workflows/add_item", publisher, workflow)).body).toEqual({
      name: "add_item",
      environment: "prod",
      command: false,
      replaced: false,
    });
    const command = { ...workflow, params: [{ name: "name", description: "Item name" }] };
    expect((await call("PUT", "/v1/workflows/add_item", publisher, command)).body).toEqual({
      name: "add_item",
      environment: "prod",
      command: true,
      replaced: true,
    });
    expect((await call("PUT", "/v1/workflows/Bad Name", publisher, workflow)).status).toBe(400);

    const listed = await call("GET", "/v1/workflows", reader);
    expect(listed.body.workflows).toEqual([
      { name: "add_item", ...workflow, params: [{ name: "name", description: "Item name", required: false }] },
    ]);

    expect((await call("DELETE", "/v1/workflows/add_item", publisher)).status).toBe(200);
    expect((await call("DELETE", "/v1/workflows/add_item", publisher)).status).toBe(404);
  });

  it("keeps each environment's workflows apart and honours a token's environments", async () => {
    expect((await call("PUT", "/v1/workflows/add_item?environment=staging", previewer, workflow)).body).toMatchObject({
      environment: "staging",
    });
    expect((await call("PUT", "/v1/workflows/add_item", previewer, workflow)).status).toBe(403);
    expect((await call("GET", "/v1/workflows?environment=staging", reader)).body.workflows.map((w: { name: string }) => w.name)).toEqual([
      "add_item",
    ]);
    expect((await call("GET", "/v1/workflows", reader)).body.workflows).toEqual([]);
    expect((await call("PUT", "/v1/workflows/add_item?environment=qa", admin, workflow)).status).toBe(404);
    expect((await call("DELETE", "/v1/workflows/add_item?environment=staging", previewer)).status).toBe(200);
  });

  it("keeps the instructions hosts get, workflows included, within the limit", async () => {
    expect((await call("PUT", "/v1/instructions", publisher, { instructions: "Acme." })).status).toBe(403);
    expect((await call("PUT", "/v1/instructions", admin, { instructions: " Acme returns. " })).body).toEqual({
      environment: "prod",
      instructions: "Acme returns.",
    });
    expect((await call("GET", "/v1/instructions", reader)).body.instructions).toBe("Acme returns.");

    const long = { description: "Long.", instructions: "x".repeat(47000) };
    expect((await call("PUT", "/v1/workflows/one", publisher, long)).status).toBe(201);
    const over = await call("PUT", "/v1/workflows/two", publisher, long);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/at most 50000.*one \(47000\)/);
    // As a command it isn't in the instructions, so it fits.
    expect((await call("PUT", "/v1/workflows/two", publisher, { ...long, params: [{ name: "x", description: "X" }] })).status).toBe(201);
    expect((await call("PUT", "/v1/instructions", admin, { instructions: "y".repeat(4000) })).status).toBe(400);

    await call("DELETE", "/v1/workflows/one", publisher);
    await call("DELETE", "/v1/workflows/two", publisher);
    expect((await call("PUT", "/v1/instructions", admin, { instructions: null })).body.instructions).toBeNull();
  });
});

describe("auto versioning", () => {
  const auto = (html: string, extra: Record<string, unknown> = {}, environment?: string) =>
    call("POST", "/v1/components", publisher, {
      manifest: { name: "poll", description: "Ask a poll.", props: { type: "object" }, ...extra },
      html: HTML(html),
      environment,
    });

  it("starts at 0.1.0, bumps the patch on any change and keeps the version when nothing changed", async () => {
    expect(await auto("a")).toMatchObject({ status: 201, body: { version: "0.1.0", created: true } });
    expect(await auto("a")).toMatchObject({ status: 200, body: { version: "0.1.0", created: false } });
    expect(await auto("b")).toMatchObject({ status: 201, body: { version: "0.1.1", created: true } });
    expect(await auto("b", { description: "Ask a quick poll." })).toMatchObject({ status: 201, body: { version: "0.1.2" } });
  });

  it("reuses an older version with the same content instead of minting a new one", async () => {
    expect(await auto("a", {}, "staging")).toMatchObject({
      status: 200,
      body: { version: "0.1.0", environments: { prod: "0.1.2", staging: "0.1.0" } },
    });
  });

  it("continues after a version set by hand", async () => {
    expect((await auto("c", { version: "2.0.0" })).body.version).toBe("2.0.0");
    expect((await auto("d")).body.version).toBe("2.0.1");
  });
});
