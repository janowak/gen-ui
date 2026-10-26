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
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
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
    body: new URLSearchParams({ grant_type: "authorization_code", code: code!, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  const body = (await token.json()) as { access_token?: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token!;
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
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
  auth = await enableManagement(created.app, db, store, { baseURL: base, secret: "test-secret-test-secret-test-secret", mode: "self-hosted", adminEmails: [], allowedEmails: [], password: true }, { assets, fetchClientMetadataResource });

  // Stand-in for Claude's Client ID Metadata Document: a public client registered for the test.
  const owner = await signUp("owner@acme.test");
  const res = await fetch(`${base}/api/auth/oauth2/create-client`, {
    method: "POST",
    headers: { cookie: owner, "content-type": "application/json", origin: base },
    body: JSON.stringify({ client_name: "Test host", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", application_type: "native" }),
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
      expect.arrayContaining(["manage_components", "use_environment", "open_theme_controller", "preview_form", "preview_chart", "preview_rating", "theme_save"]),
    );
    expect(Object.keys(byName).filter((n) => n.startsWith("component_"))).toEqual([]);
    expect((byName.theme_save?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    expect(byName.preview_rating?.title).toBe("Preview rating 1.0.0 (prod)");

    const listed = await admin.callTool({ name: "manage_components", arguments: {} });
    expect(listed.structuredContent).toEqual({
      role: "admin",
      environment: "prod",
      environments: ["prod", "staging"],
      components: [{ name: "rating", environments: { prod: "1.0.0", staging: "1.1.0" }, versions: ["1.1.0", "1.0.0"] }],
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
    const chart = await staging.callTool({ name: "preview_chart", arguments: { type: "pie", data: { categories: ["A", "B"], series: [{ name: "n", values: [1, 2] }] } } });
    expect(chart.isError).toBeFalsy();
    expect(chart._meta?.["genui/theme"]).toEqual({ light: { primary: "#16a34a" } });

    // Component previews get the same _meta contract as a customer server, with no tools approved.
    const preview = await staging.callTool({ name: "preview_rating", arguments: { question: "How was it?" } });
    expect(preview._meta).toMatchObject({ "genui/preview": true, "genui/theme": { light: { primary: "#16a34a" } } });
    expect(preview._meta?.["genui/viewId"]).toEqual(expect.any(String));
    expect(preview.structuredContent).toEqual({ genui: { id: preview._meta?.["genui/viewId"] } });
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
      expect((tools.find((t) => t.name === name)?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
    expect((await admin.callTool({ name: "workflow_save", arguments: { workflow } })).isError).toBeFalsy();
    expect(await store.listWorkflows(workspaceId, "prod")).toEqual([workflow]);
    expect((await admin.callTool({ name: "manage_workflows", arguments: {} })).content).toEqual([
      { type: "text", text: "Workflows in prod:\n- /add_item (name): The user wants to add an item." },
    ]);

    // The view sends the environment it showed; a save lands there.
    expect((await admin.callTool({ name: "workflow_save", arguments: { workflow, environment: "staging" } })).structuredContent).toMatchObject({ environment: "staging" });
    expect((await store.listWorkflows(workspaceId, "staging")).map((w) => w.name)).toEqual(["add_item"]);
    expect((await admin.callTool({ name: "workflow_save", arguments: { workflow, environment: "qa" } })).isError).toBe(true);
    expect((await admin.callTool({ name: "workflow_delete", arguments: { name: "add_item", environment: "staging" } })).structuredContent).toMatchObject({ mode: "list", workflows: [] });
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

  it("lets admins invite people, create and revoke tokens, and make the end-user MCP private, by clicking in the view", async () => {
    await store.invite(workspaceId, "frank@acme.test", "admin");
    const cookie = await signUp("frank@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "frank@acme.test");
    const admin = await mcpClient(await accessToken(cookie));

    const tools = (await admin.listTools()).tools;
    for (const name of ["member_invite", "invite_cancel", "token_create", "token_revoke", "public_set"]) {
      expect((tools.find((t) => t.name === name)?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }

    // The model can prefill an invite; only the click sends it.
    const shown = await admin.callTool({ name: "manage_workspace", arguments: { invite: { email: "gina@acme.test", role: "admin" } } });
    expect(shown.structuredContent).toMatchObject({ role: "admin", public: true, draftInvite: { email: "gina@acme.test", role: "admin" } });
    expect((shown.structuredContent as { connectors: { url: string }[] }).connectors[0]?.url).toBe(`${base}/w/${workspaceId}/mcp`);
    expect((await store.listMembers(workspaceId)).invites.map((i) => i.email)).not.toContain("gina@acme.test");
    await admin.callTool({ name: "member_invite", arguments: { email: "gina@acme.test", role: "admin" } });
    expect((await store.listMembers(workspaceId)).invites).toContainEqual({ email: "gina@acme.test", role: "admin" });
    await admin.callTool({ name: "invite_cancel", arguments: { email: "gina@acme.test" } });
    expect((await store.listMembers(workspaceId)).invites.map((i) => i.email)).not.toContain("gina@acme.test");

    // The token goes to the view only, never into the text the model reads.
    const created = await admin.callTool({ name: "token_create", arguments: { name: "prod server" } });
    const { token } = (created.structuredContent as { created: { token: string } }).created;
    expect(token).toMatch(/^gnu_server_/);
    expect(JSON.stringify(created.content)).not.toContain(token);
    expect(await store.resolveToken(token)).toMatchObject({ workspaceId, scope: "server" });

    // Private: no token, no MCP; the server token still works until it's revoked.
    await admin.callTool({ name: "public_set", arguments: { enabled: false } });
    const post = (headers: Record<string, string> = {}) =>
      fetch(`${base}/w/${workspaceId}/revision`, { headers });
    expect((await post()).status).toBe(404);
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200);
    const listed = (await admin.callTool({ name: "manage_workspace", arguments: {} })).structuredContent as { tokens: { id: string; name: string }[] };
    await admin.callTool({ name: "token_revoke", arguments: { id: listed.tokens.find((t) => t.name === "prod server")!.id } });
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401);
    await admin.callTool({ name: "public_set", arguments: { enabled: true } });
    expect((await post()).status).toBe(200);

    // Members see people and addresses, not tokens.
    const member = await mcpClient(await accessToken(await signUp("hank@acme.test")));
    const view = (await member.callTool({ name: "manage_workspace", arguments: {} })).structuredContent;
    expect(view).toMatchObject({ role: "member", public: true });
    expect(view).not.toHaveProperty("tokens");
  });

  it("drafts instructions for review; branding and saves are clicks in the views", async () => {
    await store.invite(workspaceId, "ivy@acme.test", "admin");
    const cookie = await signUp("ivy@acme.test");
    await db.run("UPDATE user SET emailVerified = 1 WHERE email = ?", "ivy@acme.test");
    const admin = await mcpClient(await accessToken(cookie));
    const tools = (await admin.listTools()).tools;
    for (const name of ["branding_save", "instructions_save"]) {
      expect((tools.find((t) => t.name === name)?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }

    const instructions = "Acme handles returns.";
    const drafted = await admin.callTool({ name: "draft_instructions", arguments: { instructions } });
    expect(drafted.structuredContent).toMatchObject({ mode: "draft", environment: "prod", instructions });
    expect(await store.getInstructions(workspaceId, "prod")).toBeNull();
    const saved = await admin.callTool({ name: "instructions_save", arguments: { instructions } });
    expect(saved.structuredContent).toMatchObject({ mode: "view", saved: true, instructions });
    // What hosts get: the instructions with the workflows added.
    await store.saveWorkflow(workspaceId, "prod", { name: "returns", description: "A return.", instructions: "Ask for the order.", params: [] });
    expect((await admin.callTool({ name: "manage_instructions", arguments: {} })).structuredContent).toMatchObject({
      instructions,
      served: expect.stringMatching(new RegExp(`^${instructions}\n\n## Workflows\n[\\s\\S]*### returns\nWhen: A return.\nAsk for the order.$`)),
    });
    await store.deleteWorkflow(workspaceId, "prod", "returns");

    // The icon arrives base64 from the view and is served next to the end-user MCP.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const bad = await admin.callTool({ name: "branding_save", arguments: { branding: {}, icon: Buffer.from("<script>").toString("base64") } });
    expect(bad.isError).toBe(true);
    const branded = await admin.callTool({ name: "branding_save", arguments: { branding: { title: "Acme Support" }, icon: png } });
    const { branding } = branded.structuredContent as { branding: { title: string; iconUrl: string } };
    expect(branding.title).toBe("Acme Support");
    expect(branding.iconUrl).toMatch(new RegExp(`^${base}/w/${workspaceId}/icon\\?v=`));
    expect((await fetch(branding.iconUrl)).headers.get("content-type")).toBe("image/png");
    // Leaving the icon out keeps it.
    const kept = await admin.callTool({ name: "branding_save", arguments: { branding: {} } });
    expect((kept.structuredContent as { branding: { iconUrl: string | null; title?: string } }).branding).toEqual({ iconUrl: branding.iconUrl });
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
