import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createRegistryApp, type Store } from "./app.js";
import { enableManagement } from "./management.js";
import { loadAssets, testDatabase } from "./testing.js";

// One login, several workspaces, on a hosted registry: the console switches, the CLI page and the
// OAuth consent pick one.

let server: ServerType;
let base: string;
let store: Store;
let clientId: string;
let cookie: string;
let personal: string;
let demo: string;
const redirectUri = "http://127.0.0.1:9/callback";

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

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie, ...headers },
    body: JSON.stringify(body),
  });

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}
const console_ = () => connect(`${base}/manage/mcp`, { cookie, origin: base });
const connector = (token: string) => connect(`${base}/mcp`, { authorization: `Bearer ${token}` });

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as { text: string }[])[0]!.text);
  return result.structuredContent as T;
}
const workspaceName = async (client: Client) => (await call<{ workspace: { name: string } }>(client, "show_workspace")).workspace.name;

beforeAll(async () => {
  const db = await testDatabase();
  const assets = await loadAssets();
  const created = createRegistryApp(db, { assets });
  store = created.store;
  server = serve({ fetch: (req) => created.app.fetch(req), port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  enableManagement(
    created.app,
    db,
    store,
    {
      baseURL: base,
      secret: "test-secret-test-secret-test-secret",
      mode: "hosted",
      adminEmails: [],
      allowedEmails: [],
      password: true,
    },
    { assets, fetchClientMetadataResource },
  );
  cookie = await signUp("ann@acme.test");
  const res = await post("/api/auth/oauth2/create-client", {
    client_name: "Test host",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    application_type: "native",
  });
  clientId = ((await res.json()) as { client_id: string }).client_id;
});

afterAll(() => server?.close());

describe("several workspaces per login", () => {
  it("creates and switches workspaces from the console", async () => {
    let client = await console_();
    const first = await call<{ current: string; workspaces: { id: string; name: string }[] }>(client, "list_workspaces");
    expect(first.workspaces).toHaveLength(1);
    personal = first.current;
    expect(await workspaceName(client)).toBe("ann's workspace");
    // A personal workspace's address reads as the person, not as "ann-s-workspace".
    expect(first.workspaces[0]).toMatchObject({ slug: "ann" });

    const made = await call<{ workspaces: { id: string; name: string; active: boolean }[] }>(client, "create_workspace", { name: "demo" });
    demo = made.workspaces.find((w) => w.name === "demo")!.id;
    expect(made.workspaces.find((w) => w.active)?.id).toBe(demo);
    // The console follows the active workspace on its next request.
    client = await console_();
    expect(await workspaceName(client)).toBe("demo");

    await call(client, "switch_workspace", { workspace: personal });
    expect(await workspaceName(await console_())).toBe("ann's workspace");
    await expect(call(client, "switch_workspace", { workspace: "nope" })).rejects.toThrow(/aren't a member/);
  });

  it("lets the CLI page pick which workspace the token is for", async () => {
    const workspaces = await fetch(`${base}/cli/workspace`, { headers: { cookie } }).then((r) => r.json());
    expect(workspaces).toEqual({
      workspaces: [
        { id: personal, name: "ann's workspace", admin: true },
        { id: demo, name: "demo", admin: true },
      ],
    });

    const verifier = randomBytes(32).toString("base64url");
    const request = {
      port: 51234,
      state: randomBytes(16).toString("base64url"),
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      device: "test-laptop",
    };
    const approved = await post("/cli/approve", { ...request, workspace: demo });
    const code = new URL(((await approved.json()) as { url: string }).url).searchParams.get("code");
    const traded = (await (await post("/cli/token", { code, verifier })).json()) as { token: string; workspace: { name: string } };
    expect(traded.workspace.name).toBe("demo");
    const whoami = await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${traded.token}` } });
    expect(((await whoami.json()) as { workspace: { id: string } }).workspace.id).toBe(demo);

    // Not someone else's workspace.
    const bob = await signUp("bob@other.test");
    const others = await fetch(`${base}/cli/workspace`, { headers: { cookie: bob } }).then(
      (r) => r.json() as Promise<{ workspaces: { id: string }[] }>,
    );
    expect((await post("/cli/approve", { ...request, workspace: others.workspaces[0]!.id })).status).toBe(403);
  });

  it("asks which workspace an MCP connector manages, and keeps it there", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      state: "xyz",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    }))
      authorize.searchParams.set(k, v);

    // Two workspaces: the picker comes before consent.
    const toPicker = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
    const pickerUrl = new URL(toPicker.headers.get("location") ?? ((await toPicker.json()) as { url: string }).url, base);
    expect(pickerUrl.pathname).toBe("/consent/workspace");
    expect((await fetch(pickerUrl, { headers: { cookie } })).status).toBe(200);

    // The page makes the pick the active workspace, then resumes the flow (what consent.ts does).
    expect((await post("/workspaces/active", { workspace: demo })).status).toBe(200);
    expect((await post("/workspaces/active", { workspace: demo }, { origin: "https://evil.test" })).status).toBe(403);
    const resumed = await post("/api/auth/oauth2/continue", { postLogin: true, oauth_query: pickerUrl.search.slice(1) });
    const consentUrl = new URL(((await resumed.json()) as { url: string }).url, base);
    expect(consentUrl.pathname).toBe("/consent");

    const consent = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consentUrl.search.slice(1) });
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get("code")!;
    const tokens = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${base}/mcp`,
      }),
    }).then((r) => r.json() as Promise<{ access_token: string; refresh_token: string }>);
    const client = await connector(tokens.access_token);
    expect(await workspaceName(client)).toBe("demo");
    // A connector lists and creates workspaces, but doesn't switch: it stays on the one picked.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_workspaces", "create_workspace"]));
    expect(tools.map((t) => t.name)).not.toContain("switch_workspace");

    // Switching in the console later doesn't move the connector, not even after a token refresh.
    await call(await console_(), "switch_workspace", { workspace: personal });
    const refreshed = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: `${base}/mcp`,
      }),
    }).then((r) => r.json() as Promise<{ access_token: string }>);
    expect(await workspaceName(await connector(refreshed.access_token))).toBe("demo");
    expect(await workspaceName(await console_())).toBe("ann's workspace");
  });
});
