import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createRegistryApp, type Database, type Store } from "./app.js";
import type { Auth } from "./auth.js";
import { enableManagement } from "./management.js";
import { loadAssets, testDatabase } from "./testing.js";

let server: ServerType;
let base: string;
let auth: Auth;
let store: Store;
let clientId: string;
let workspaceId: string;
let db: Database;
let ownerCookie: string;
const redirectUri = "http://127.0.0.1:9/callback";

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const rating = (version: string) => ({
  name: "rating",
  version,
  description: "Ask for a star rating.",
  props: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  tools: [],
});

/** Signs up a person and returns their session cookie. */
async function signUp(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Runs the OAuth authorization-code flow (PKCE, consent, resource indicator) like Claude would. */
async function accessToken(cookie: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  }))
    authorize.searchParams.set(k, v);

  // Signed in already, so the server sends the person to the consent page
  // (a redirect for browsers, JSON { redirect, url } for fetch clients).
  const toConsent = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
  const next = toConsent.headers.get("location") ?? ((await toConsent.json()) as { url: string }).url;
  const consentUrl = new URL(next, base);
  expect(consentUrl.pathname).toBe("/consent");

  // The consent page posts accept + the signed query (what oauthProviderClient does in the browser).
  const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
  });
  const { url } = (await consent.json()) as { url: string };
  const code = new URL(url).searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  const body = (await token.json()) as { access_token?: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token!;
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return client;
}

beforeAll(async () => {
  db = await testDatabase();
  const assets = await loadAssets();
  const created = createRegistryApp(db, { assets });
  store = created.store;
  const ws = await store.createWorkspace("acme");
  workspaceId = ws;
  await store.createEnvironment(ws, "staging");
  await store.publish(ws, rating("1.0.0"), html("v1"));
  await store.publish(ws, rating("1.1.0"), html("v1.1"), "staging");

  server = serve({ fetch: (req) => created.app.fetch(req), port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  auth = await enableManagement(
    created.app,
    db,
    store,
    {
      baseURL: base,
      secret: "test-secret-test-secret-test-secret",
      mode: "self-hosted",
      adminEmails: [],
      allowedEmails: [],
      password: true,
    },
    { assets, fetchClientMetadataResource },
  );

  // Stand-in for Claude's Client ID Metadata Document: a public client registered for the test.
  const owner = (ownerCookie = await signUp("owner@acme.test"));
  const res = await fetch(`${base}/api/auth/oauth2/create-client`, {
    method: "POST",
    headers: { cookie: owner, "content-type": "application/json", origin: base },
    body: JSON.stringify({
      client_name: "Test host",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  clientId = ((await res.json()) as { client_id: string }).client_id;
  expect(clientId).toBeTruthy();
});

afterAll(() => server?.close());

describe("management MCP", () => {
  it("advertises OAuth discovery for MCP clients", async () => {
    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthenticated.status).toBe(401);
    const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");

    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    const resource = (await (await fetch(metadataUrl!)).json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(`${base}/mcp`);

    const issuer = resource.authorization_servers[0]!;
    const asUrl = `${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname.replace(/\/$/, "")}`;
    const as = (await (await fetch(asUrl)).json()) as Record<string, unknown>;
    expect(as.authorization_endpoint).toBeTruthy();
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  it("gives the first person admin tools; saves are app-only", async () => {
    const token = await accessToken(await signUp("alice@acme.test"));
    const admin = await mcpClient(token);
    const { tools } = await admin.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        "manage_components",
        "use_environment",
        "open_theme_controller",
        "preview_form",
        "preview_chart",
        "preview_rating",
        "theme_save",
      ]),
    );
    // Publishing stays with CI; stopping a component and the built-ins switch are clicks in the view.
    for (const name of ["theme_save", "component_remove", "built_ins_set"]) {
      expect((byName[name]!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
    expect(byName.preview_rating?.title).toBe("Preview rating 1.0.0 (prod)");

    const listed = await admin.callTool({ name: "manage_components", arguments: {} });
    expect(listed.structuredContent).toEqual({
      role: "admin",
      environment: "prod",
      environments: ["prod", "staging"],
      components: [{ name: "rating", environments: { prod: "1.0.0", staging: "1.1.0" }, versions: ["1.1.0", "1.0.0"] }],
      builtIns: true,
    });

    // Switching changes only this person's previews, theme, instructions and workflows, and holds across connections.
    expect((await admin.callTool({ name: "use_environment", arguments: { name: "qa" } })).isError).toBe(true);
    const switched = await admin.callTool({ name: "use_environment", arguments: { name: "staging" } });
    expect(switched.structuredContent).toMatchObject({ environment: "staging" });
    const staging = await mcpClient(token);
    expect((await staging.listTools()).tools.find((t) => t.name === "preview_rating")?.title).toBe("Preview rating 1.1.0 (staging)");

    const saved = await staging.callTool({ name: "theme_save", arguments: { theme: { light: { primary: "#16a34a" } } } });
    expect(saved.isError).toBeFalsy();
    expect(await store.getTheme(workspaceId, "staging")).toEqual({ light: { primary: "#16a34a" } });
    expect(await store.getTheme(workspaceId, "prod")).toBeNull();
    const theme = await staging.callTool({ name: "open_theme_controller", arguments: {} });
    expect(theme.structuredContent).toMatchObject({ role: "admin", environment: "staging", theme: { light: { primary: "#16a34a" } } });

    // Built-in previews render inline data with the active environment's theme.
    const chart = await staging.callTool({
      name: "preview_chart",
      arguments: { type: "pie", data: { categories: ["A", "B"], series: [{ name: "n", values: [1, 2] }] } },
    });
    expect(chart.isError).toBeFalsy();
    expect(chart._meta?.["app-mcp/theme"]).toEqual({ light: { primary: "#16a34a" } });

    // Component previews get the same _meta contract as a customer server, with no tools approved.
    const preview = await staging.callTool({ name: "preview_rating", arguments: { question: "How was it?" } });
    expect(preview._meta).toMatchObject({ "app-mcp/preview": true, "app-mcp/theme": { light: { primary: "#16a34a" } } });
    expect(preview._meta?.["app-mcp/viewId"]).toEqual(expect.any(String));
    expect(preview.structuredContent).toEqual({ appMcp: { id: preview._meta?.["app-mcp/viewId"] } });
  });

  it("drafts workflows for review; only an admin click saves them", async () => {
    await store.invite(workspaceId, "dana@acme.test", "admin");
    const cookie = await signUp("dana@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "dana@acme.test");
    const admin = await mcpClient(await accessToken(cookie));
    const workflow = {
      name: "add_item",
      description: "The user wants to add an item.",
      instructions: "Show a form with the name and submit to create_item.",
      params: [{ name: "name", description: "Item name", required: false }],
    };

    const draft = await admin.callTool({ name: "draft_workflow", arguments: workflow });
    expect(draft.structuredContent).toMatchObject({ mode: "draft", replaces: false, workflow });
    expect(await store.listWorkflows(workspaceId, "prod")).toEqual([]);

    const tools = (await admin.listTools()).tools;
    for (const name of ["workflow_save", "workflow_delete"]) {
      expect((tools.find((t) => t.name === name)!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
    expect((await admin.callTool({ name: "workflow_save", arguments: { workflow } })).isError).toBeFalsy();
    expect(await store.listWorkflows(workspaceId, "prod")).toEqual([workflow]);
    expect((await admin.callTool({ name: "manage_workflows", arguments: {} })).content).toEqual([
      { type: "text", text: "Workflows in prod:\n- /add_item (name): The user wants to add an item." },
    ]);

    // The view sends the environment it showed; a save lands there.
    expect(
      (await admin.callTool({ name: "workflow_save", arguments: { workflow, environment: "staging" } })).structuredContent,
    ).toMatchObject({ environment: "staging" });
    expect((await store.listWorkflows(workspaceId, "staging")).map((w) => w.name)).toEqual(["add_item"]);
    expect((await admin.callTool({ name: "workflow_save", arguments: { workflow, environment: "qa" } })).isError).toBe(true);
    expect(
      (await admin.callTool({ name: "workflow_delete", arguments: { name: "add_item", environment: "staging" } })).structuredContent,
    ).toMatchObject({ mode: "list", workflows: [] });
  });

  it("lets admins stop serving a component and turn the built-ins off, by clicking in the view", async () => {
    await store.invite(workspaceId, "omar@acme.test", "admin");
    const cookie = await signUp("omar@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "omar@acme.test");
    const admin = await mcpClient(await accessToken(cookie));
    await store.createEnvironment(workspaceId, "qa");
    await store.deployVersion(workspaceId, "rating", "1.0.0", "qa");

    const off = await admin.callTool({ name: "built_ins_set", arguments: { enabled: false, environment: "qa" } });
    expect(off.structuredContent).toMatchObject({ environment: "qa", builtIns: false });
    expect((await store.catalog(workspaceId, "qa")).builtIns).toBe(false);

    const removed = await admin.callTool({ name: "component_remove", arguments: { name: "rating", environment: "qa" } });
    expect(removed.structuredContent).toMatchObject({
      environment: "qa",
      components: [{ name: "rating", environments: { prod: "1.0.0", staging: "1.1.0" } }],
    });
    expect((await admin.callTool({ name: "component_remove", arguments: { name: "rating", environment: "qa" } })).isError).toBe(true);
    await store.deleteEnvironment(workspaceId, "qa");
  });

  it("gives later people member tools only", async () => {
    const member = await mcpClient(await accessToken(await signUp("bob@acme.test")));
    const names = (await member.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["manage_components", "use_environment", "open_theme_controller", "preview_rating"]));
    expect(names).not.toContain("workflow_save");
    expect(names).not.toContain("theme_save");
    const listed = await member.callTool({ name: "manage_components", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ role: "member" });
  });

  it("gives invited people the invited role at first sign-in", async () => {
    await store.invite(workspaceId, "Carol@Acme.test", "admin");
    await store.invite(workspaceId, "mallory@acme.test", "admin");

    // Password sign-ups have unverified emails and must not claim invites.
    const mallory = await mcpClient(await accessToken(await signUp("mallory@acme.test")));
    expect((await mallory.listTools()).tools.map((t) => t.name)).not.toContain("theme_save");

    // A verified email (as GitHub / Google / the company IdP provide) claims the invite.
    const cookie = await signUp("carol@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "carol@acme.test");
    const carol = await mcpClient(await accessToken(cookie));
    expect((await carol.listTools()).tools.map((t) => t.name)).toContain("theme_save");
  });

  it("lets admins change people, environments and the public MCP with tools the model calls", async () => {
    await store.invite(workspaceId, "frank@acme.test", "admin");
    const cookie = await signUp("frank@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "frank@acme.test");
    const admin = await mcpClient(await accessToken(cookie));

    // Settings are plain tools; only secrets and the icon file stay with clicks in the views.
    const tools = Object.fromEntries((await admin.listTools()).tools.map((t) => [t.name, t]));
    const direct = ["workspace_rename", "public_set", "environment_create", "member_invite", "invite_cancel", "member_set_role"];
    for (const name of [...direct, "member_remove", "connector_set", "token_revoke"]) {
      expect(tools[name], name).toBeDefined();
      expect((tools[name]!._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
    }
    for (const name of ["show_workspace", "list_members", "list_tokens", "edit_connector", "token_create"]) {
      expect((tools[name]!._meta as { ui: { visibility?: string[] } }).ui.visibility).toBeUndefined();
    }
    for (const name of ["token_reveal", "token_rotate", "connector_icon_set"]) {
      expect((tools[name]!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }

    const shown = await admin.callTool({ name: "show_workspace", arguments: {} });
    expect(shown.structuredContent).toMatchObject({ role: "admin", public: true, workspace: { name: "acme" } });
    expect((shown.structuredContent as { connectors: { url: string }[] }).connectors[0]?.url).toBe(`${base}/w/${workspaceId}/mcp`);
    expect(JSON.stringify(shown.content)).toContain(`prod: ${base}/w/${workspaceId}/mcp`);

    await admin.callTool({ name: "workspace_rename", arguments: { name: "Acme Inc" } });
    expect((await store.workspace(workspaceId))?.name).toBe("Acme Inc");
    await admin.callTool({ name: "workspace_rename", arguments: { name: "acme" } });

    await admin.callTool({ name: "member_invite", arguments: { email: "gina@acme.test", role: "admin" } });
    expect((await store.listMembers(workspaceId)).invites).toContainEqual({ email: "gina@acme.test", role: "admin" });
    const cancelled = await admin.callTool({ name: "invite_cancel", arguments: { email: "gina@acme.test" } });
    expect((cancelled.structuredContent as { invites: { email: string }[] }).invites.map((i) => i.email)).not.toContain("gina@acme.test");

    // Roles and removal go by the email people signed in with; a removed person's connector stops working.
    const hank = await mcpClient(await accessToken(await signUp("hank@acme.test")));
    expect((await hank.listTools()).tools.map((t) => t.name)).not.toContain("list_tokens");
    await admin.callTool({ name: "member_set_role", arguments: { email: "hank@acme.test", role: "admin" } });
    const promoted = (await store.listMembers(workspaceId)).members.find((m) => m.email === "hank@acme.test");
    expect(promoted?.role).toBe("admin");
    expect((await admin.callTool({ name: "member_remove", arguments: { email: "nobody@acme.test" } })).isError).toBe(true);
    const removed = await admin.callTool({ name: "member_remove", arguments: { email: "hank@acme.test" } });
    expect(JSON.stringify(removed.structuredContent)).not.toContain("hank@acme.test");
    await expect(hank.listTools()).rejects.toThrow();

    expect((await admin.callTool({ name: "environment_create", arguments: { name: "QA" } })).isError).toBe(true);
    const created = await admin.callTool({ name: "environment_create", arguments: { name: "preview" } });
    expect(JSON.stringify(created.content)).toContain(`${base}/w/${workspaceId}/preview/mcp`);
    expect(await store.listEnvironments(workspaceId)).toContain("preview");
    expect((await admin.callTool({ name: "environment_create", arguments: { name: "preview" } })).isError).toBe(true);
    await store.deleteEnvironment(workspaceId, "preview");

    await admin.callTool({ name: "public_set", arguments: { enabled: false } });
    expect((await fetch(`${base}/w/${workspaceId}/revision`)).status).toBe(404);
    await admin.callTool({ name: "public_set", arguments: { enabled: true } });
    expect((await fetch(`${base}/w/${workspaceId}/revision`)).status).toBe(200);

    // Members see the summary and the people, not tokens.
    const member = await mcpClient(await accessToken(await signUp("ida@acme.test")));
    const names = (await member.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["show_workspace", "list_members"]));
    for (const name of ["list_tokens", "member_invite", "public_set", "edit_connector"]) expect(names).not.toContain(name);
    const summary = (await member.callTool({ name: "show_workspace", arguments: {} })).structuredContent as { counts: object };
    expect(summary).toMatchObject({ role: "member", public: true });
    expect(summary.counts).not.toHaveProperty("tokens");
  });

  it("keeps the workspace with an admin", async () => {
    const ws = await store.createWorkspace("solo");
    await store.addMember(ws, "u-admin", "admin");
    await store.addMember(ws, "u-member", "member");
    await expect(store.setRole(ws, "u-admin", "member")).rejects.toMatchObject({ status: 409 });
    await expect(store.removeMember(ws, "u-admin")).rejects.toMatchObject({ status: 409 });
    await store.setRole(ws, "u-member", "admin");
    await store.setRole(ws, "u-admin", "member");
    await store.removeMember(ws, "u-admin");
    await expect(store.removeMember(ws, "u-admin")).rejects.toMatchObject({ status: 404 });
  });

  it("creates tokens from chat, but shows a secret only once, in the view", async () => {
    await store.invite(workspaceId, "jules@acme.test", "admin");
    const cookie = await signUp("jules@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "jules@acme.test");
    const admin = await mcpClient(await accessToken(cookie));

    // The model creates the token; it has no secret yet, so nothing secret reaches the chat.
    const created = await admin.callTool({ name: "token_create", arguments: { name: "prod server" } });
    const { highlight, tokens } = created.structuredContent as { highlight: string; tokens: { id: string; revealed: boolean }[] };
    expect(tokens.find((t) => t.id === highlight)).toMatchObject({ revealed: false });
    expect(JSON.stringify(created)).not.toContain("gnu_");

    // Reveal (a click in the view) makes the secret and returns it once, outside the text.
    const revealed = await admin.callTool({ name: "token_reveal", arguments: { id: highlight } });
    const secret = (revealed.structuredContent as { secret: { id: string; token: string } }).secret.token;
    expect(secret).toMatch(/^gnu_server_/);
    expect(JSON.stringify(revealed.content)).not.toContain(secret);
    expect(await store.resolveToken(secret)).toMatchObject({ workspaceId, scope: "server" });
    expect((await admin.callTool({ name: "token_reveal", arguments: { id: highlight } })).isError).toBe(true);
    const listed = await admin.callTool({ name: "list_tokens", arguments: {} });
    expect(JSON.stringify(listed)).not.toContain("gnu_");
    expect((listed.structuredContent as { tokens: { id: string; revealed: boolean }[] }).tokens).toContainEqual(
      expect.objectContaining({ id: highlight, revealed: true }),
    );

    // Rotating replaces the secret; the old one stops working.
    const rotated = await admin.callTool({ name: "token_rotate", arguments: { id: highlight } });
    const next = (rotated.structuredContent as { secret: { token: string } }).secret.token;
    expect(await store.resolveToken(secret)).toBeUndefined();
    expect(await store.resolveToken(next)).toMatchObject({ workspaceId });

    // A private MCP still serves the token until it's revoked.
    await admin.callTool({ name: "public_set", arguments: { enabled: false } });
    const revision = (token: string) => fetch(`${base}/w/${workspaceId}/revision`, { headers: { authorization: `Bearer ${token}` } });
    expect((await revision(next)).status).toBe(200);
    await admin.callTool({ name: "token_revoke", arguments: { id: highlight } });
    expect((await revision(next)).status).toBe(401);
    await admin.callTool({ name: "public_set", arguments: { enabled: true } });

    // Publish tokens can be limited to environments; other scopes can't.
    const limited = await admin.callTool({ name: "token_create", arguments: { name: "ci", scope: "publish", environments: ["staging"] } });
    expect((limited.structuredContent as { tokens: { name: string; environments: string[] | null }[] }).tokens).toContainEqual(
      expect.objectContaining({ name: "ci", environments: ["staging"] }),
    );
    expect(
      (await admin.callTool({ name: "token_create", arguments: { name: "x", scope: "server", environments: ["staging"] } })).isError,
    ).toBe(true);
  });

  it("drafts instructions for review, and sets the connector from chat or the form", async () => {
    await store.invite(workspaceId, "ivy@acme.test", "admin");
    const cookie = await signUp("ivy@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "ivy@acme.test");
    const admin = await mcpClient(await accessToken(cookie));
    const tools = (await admin.listTools()).tools;
    for (const name of ["instructions_save"]) {
      expect((tools.find((t) => t.name === name)!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }

    const instructions = "Acme handles returns.";
    const drafted = await admin.callTool({ name: "draft_instructions", arguments: { instructions } });
    expect(drafted.structuredContent).toMatchObject({ mode: "draft", environment: "prod", instructions });
    expect(await store.getInstructions(workspaceId, "prod")).toBeNull();
    const saved = await admin.callTool({ name: "instructions_save", arguments: { instructions } });
    expect(saved.structuredContent).toMatchObject({ mode: "view", saved: true, instructions });
    // What hosts get: the instructions with the workflows added.
    await store.saveWorkflow(workspaceId, "prod", {
      name: "returns",
      description: "A return.",
      instructions: "Ask for the order.",
      params: [],
    });
    expect((await admin.callTool({ name: "manage_instructions", arguments: {} })).structuredContent).toMatchObject({
      instructions,
      served: expect.stringMatching(
        new RegExp(`^${instructions}\n\n## Workflows\n[\\s\\S]*### returns\nWhen: A return.\nAsk for the order.$`),
      ),
    });
    await store.deleteWorkflow(workspaceId, "prod", "returns");

    // The model can prefill the connector form for review, or set fields directly; only the passed ones change.
    const draft = await admin.callTool({ name: "edit_connector", arguments: { title: "Acme Support" } });
    expect(draft.structuredContent).toMatchObject({ draft: { title: "Acme Support" }, branding: { iconUrl: null } });
    expect((await store.branding(workspaceId)).title).toBeUndefined();
    await admin.callTool({ name: "connector_set", arguments: { title: "Acme Support" } });
    const described = await admin.callTool({ name: "connector_set", arguments: { description: "Returns and orders." } });
    expect((described.structuredContent as { branding: object }).branding).toEqual({
      title: "Acme Support",
      description: "Returns and orders.",
      iconUrl: null,
    });
    expect((await admin.callTool({ name: "connector_set", arguments: { websiteUrl: "javascript:alert(1)" } })).isError).toBe(true);
    await admin.callTool({ name: "connector_set", arguments: { description: null } });
    expect(await store.branding(workspaceId)).toEqual({ title: "Acme Support", icon: null });

    // The icon arrives base64 from the form (app-only) and is served next to the end-user MCP.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const bad = await admin.callTool({ name: "connector_icon_set", arguments: { icon: Buffer.from("<script>").toString("base64") } });
    expect(bad.isError).toBe(true);
    const iconed = await admin.callTool({ name: "connector_icon_set", arguments: { icon: png } });
    const { iconUrl } = (iconed.structuredContent as { branding: { iconUrl: string } }).branding;
    expect(iconUrl).toMatch(new RegExp(`^${base}/w/${workspaceId}/icon\\?v=`));
    expect((await fetch(iconUrl)).headers.get("content-type")).toBe("image/png");
    // Setting fields keeps the icon.
    const kept = await admin.callTool({ name: "connector_set", arguments: { title: null } });
    expect((kept.structuredContent as { branding: object }).branding).toEqual({ iconUrl });
    await admin.callTool({ name: "connector_icon_set", arguments: { icon: null } });
    expect((await store.branding(workspaceId)).icon).toBeNull();
  });

  it("rejects a token for another resource", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(auth).toBeDefined();
  });
});

describe("web console", () => {
  it("sends people without a session to sign in, and signed-in people to the console", async () => {
    expect((await fetch(`${base}/`, { redirect: "manual" })).headers.get("location")).toBe("/manage");
    const page = await fetch(`${base}/manage`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/sign-in");

    const cookie = await signUp("erin@acme.test");
    expect((await fetch(`${base}/manage`, { headers: { cookie } })).status).toBe(200);
    const signIn = await fetch(`${base}/sign-in`, { headers: { cookie }, redirect: "manual" });
    expect(signIn.headers.get("location")).toBe("/manage");
    // An AI assistant's OAuth flow still gets the sign-in page, to pick the account.
    expect((await fetch(`${base}/sign-in?sig=abc`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
  });

  it("serves the management MCP to the session, from the registry's own origin only", async () => {
    const cookie = await signUp("heidi@acme.test");
    const list = (headers: Record<string, string>) =>
      fetch(`${base}/manage/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await list({ origin: base })).status).toBe(401);
    expect((await list({ cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await list({ cookie })).status).toBe(403);

    const web = new Client({ name: "app-mcp-web", version: "0.1.0" });
    await web.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/manage/mcp`), { requestInit: { headers: { cookie, origin: base } } }),
    );
    const names = (await web.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["show_workspace", "list_members", "manage_components"]));
    expect(names).not.toContain("list_tokens");
    const workspace = await web.callTool({ name: "show_workspace", arguments: {} });
    expect(workspace.structuredContent).toMatchObject({ role: "member", workspace: { name: "acme" } });
  });
});

describe("app-mcp login", () => {
  const verifier = randomBytes(32).toString("base64url");
  const request = {
    port: 51234,
    state: randomBytes(16).toString("base64url"),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    device: "test-laptop",
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const approve = async (cookie: string, body: unknown = request) => post("/cli/approve", body, { cookie, origin: base });
  const codeFrom = async (res: Response) => new URL(((await res.json()) as { url: string }).url).searchParams.get("code")!;

  // The owner joins the workspace on their first visit; make them an admin whoever joined first.
  beforeAll(async () => {
    await fetch(`${base}/cli/workspace`, { headers: { cookie: ownerCookie } });
    await store.setRole(workspaceId, (await store.memberByEmail(workspaceId, "owner@acme.test")).userId, "admin");
  });

  it("sends a signed-out person to sign in and back", async () => {
    const res = await fetch(`${base}/cli?port=51234&state=x`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/cli?port=51234&state=x")}`);
    const back = await fetch(`${base}${res.headers.get("location")}`, { headers: { cookie: ownerCookie }, redirect: "manual" });
    expect(back.headers.get("location")).toBe("/cli?port=51234&state=x");
    const elsewhere = await fetch(`${base}/sign-in?next=${encodeURIComponent("https://evil.test")}`, {
      headers: { cookie: ownerCookie },
      redirect: "manual",
    });
    expect(elsewhere.headers.get("location")).toBe("/manage");
    expect((await fetch(`${base}/cli?port=51234`, { headers: { cookie: ownerCookie } })).status).toBe(200);
  });

  it("gives the CLI an admin token once an admin allows it", async () => {
    const approved = await approve(ownerCookie);
    expect(approved.status).toBe(200);
    const { url } = (await approved.clone().json()) as { url: string };
    const callback = new URL(url);
    expect(callback.origin).toBe("http://127.0.0.1:51234");
    expect(callback.searchParams.get("state")).toBe(request.state);
    const code = await codeFrom(approved);

    // Until the CLI trades the code, the token authenticates nothing.
    expect((await store.listTokens(workspaceId)).find((t) => t.name === "CLI on test-laptop")).toMatchObject({
      scope: "admin",
      revealed: false,
    });

    const traded = await post("/cli/token", { code, verifier });
    expect(traded.status).toBe(200);
    const body = (await traded.json()) as { token: string; workspace: { id: string; name: string }; mcp: string };
    expect(body).toMatchObject({ workspace: { id: workspaceId, name: "acme" }, mcp: `${base}/w/${workspaceId}/mcp` });

    const whoami = await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(await whoami.json()).toEqual({ workspace: { id: workspaceId, name: "acme" }, scope: "admin", path: `/w/${workspaceId}/mcp` });

    // A code works once.
    expect((await post("/cli/token", { code, verifier })).status).toBe(400);

    // Logout: the token ends itself.
    const revoke = () => fetch(`${base}/v1/tokens/current`, { method: "DELETE", headers: { authorization: `Bearer ${body.token}` } });
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(401);
  });

  it("refuses a code without the verifier that started it, or a changed one", async () => {
    const code = await codeFrom(await approve(ownerCookie));
    expect((await post("/cli/token", { code, verifier: randomBytes(32).toString("base64url") })).status).toBe(400);
    expect((await post("/cli/token", { code: `${code.slice(0, -2)}AA`, verifier })).status).toBe(400);
    expect((await post("/cli/token", { code: "nonsense", verifier })).status).toBe(400);
    expect((await post("/cli/token", { code, verifier })).status).toBe(200);
  });

  it("only lets a signed-in admin allow it, from the registry's own page", async () => {
    expect((await post("/cli/approve", request, { origin: base })).status).toBe(401);
    expect((await post("/cli/approve", request, { cookie: ownerCookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await approve(await signUp("kim@acme.test"))).status).toBe(403);
    expect((await approve(ownerCookie, { ...request, port: 80 })).status).toBe(400);
    expect((await approve(ownerCookie, { ...request, challenge: "short" })).status).toBe(400);
    const context = await fetch(`${base}/cli/workspace`, { headers: { cookie: ownerCookie } });
    expect(await context.json()).toEqual({ workspace: "acme", admin: true });
    // Signed out is the only case that asks to sign in, so the page's redirect to sign-in can't loop.
    expect((await fetch(`${base}/cli/workspace`)).status).toBe(401);
  });
});
