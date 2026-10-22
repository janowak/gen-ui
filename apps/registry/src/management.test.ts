import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistryApp, openDatabase, type Store } from "./app.js";
import type { Auth } from "./auth.js";
import { enableManagement } from "./management.js";

let server: ServerType;
let base: string;
let auth: Auth;
let store: Store;
let clientId: string;
let workspaceId: string;
let db: ReturnType<typeof openDatabase>;
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
  db = openDatabase(":memory:");
  const created = createRegistryApp(db);
  store = created.store;
  const ws = store.createWorkspace("acme");
  workspaceId = ws;
  store.publish(ws, rating("1.0.0"), html("v1"));
  store.promote(ws, "rating");
  store.publish(ws, rating("1.1.0"), html("v1.1"));

  server = serve({ fetch: (req) => created.app.fetch(req), port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  auth = await enableManagement(created.app, db, store, { baseURL: base, secret: "test-secret-test-secret-test-secret", mode: "self-hosted", adminEmails: [], password: true });

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

  it("gives the first person admin tools; promote and rollback are app-only", async () => {
    const admin = await mcpClient(await accessToken(await signUp("alice@acme.test")));
    const { tools } = await admin.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(["manage_components", "open_theme_controller", "preview_rating", "component_promote", "component_rollback", "theme_save"]));
    expect((byName.component_promote?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);

    const listed = await admin.callTool({ name: "manage_components", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ role: "admin", components: [{ name: "rating", channels: { stable: "1.0.0", beta: "1.1.0" } }] });

    const promoted = await admin.callTool({ name: "component_promote", arguments: { name: "rating" } });
    expect(promoted.isError).toBeFalsy();
    const after = await admin.callTool({ name: "manage_components", arguments: {} });
    expect(after.structuredContent).toMatchObject({ components: [{ channels: { stable: "1.1.0" } }] });

    const saved = await admin.callTool({ name: "theme_save", arguments: { theme: { light: { primary: "#16a34a" } } } });
    expect(saved.isError).toBeFalsy();
    const theme = await admin.callTool({ name: "open_theme_controller", arguments: {} });
    expect(theme.structuredContent).toMatchObject({ role: "admin", theme: { light: { primary: "#16a34a" } } });
  });

  it("gives later people member tools only", async () => {
    const member = await mcpClient(await accessToken(await signUp("bob@acme.test")));
    const names = (await member.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["manage_components", "open_theme_controller", "preview_rating"]));
    expect(names).not.toContain("component_promote");
    expect(names).not.toContain("theme_save");
    const listed = await member.callTool({ name: "manage_components", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ role: "member" });
  });

  it("gives invited people the invited role at first sign-in", async () => {
    store.invite(workspaceId, "Carol@Acme.test", "admin");
    store.invite(workspaceId, "mallory@acme.test", "admin");

    // Password sign-ups have unverified emails and must not claim invites.
    const mallory = await mcpClient(await accessToken(await signUp("mallory@acme.test")));
    expect((await mallory.listTools()).tools.map((t) => t.name)).not.toContain("component_promote");

    // A verified email (as GitHub / Google / the company IdP provide) claims the invite.
    const cookie = await signUp("carol@acme.test");
    db.prepare("UPDATE user SET emailVerified = 1 WHERE email = ?").run("carol@acme.test");
    const carol = await mcpClient(await accessToken(cookie));
    expect((await carol.listTools()).tools.map((t) => t.name)).toContain("component_promote");
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
