import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createRegistryApp, type Store } from "./app.js";
import { enableManagement } from "./management.js";
import { loadAssets, testDatabase } from "./testing.js";

// One login, several workspaces, on a hosted registry: the console and connectors manage the active
// one and switch it; the CLI's token is for the person and each request names its workspace.

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

  it("signs the CLI in as the person, and each request names its workspace", async () => {
    expect(await fetch(`${base}/cli/workspace`, { headers: { cookie } }).then((r) => r.json())).toEqual({ email: "ann@acme.test" });

    const verifier = randomBytes(32).toString("base64url");
    const request = {
      port: 51234,
      state: randomBytes(16).toString("base64url"),
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      device: "test-laptop",
    };
    const approved = await post("/cli/approve", request);
    const code = new URL(((await approved.json()) as { url: string }).url).searchParams.get("code");
    const traded = (await (await post("/cli/token", { code, verifier })).json()) as {
      token: string;
      email: string;
      workspaces: { id: string; name: string; role: string; mcp: string }[];
    };
    expect(traded.email).toBe("ann@acme.test");
    // The one used last first: the CLI's default until `app-mcp use`.
    expect(traded.workspaces.map((w) => [w.name, w.role])).toEqual([
      ["ann's workspace", "admin"],
      ["demo", "admin"],
    ]);
    expect(traded.workspaces[1]!.mcp).toBe(`${base}/w/${demo}/mcp`);

    const as = (workspace?: string) => ({
      authorization: `Bearer ${traded.token}`,
      ...(workspace ? { "x-app-mcp-workspace": workspace } : {}),
    });
    const whoami = (workspace?: string) => fetch(`${base}/v1/whoami`, { headers: as(workspace) }).then((r) => r.json());

    // Naming none, with two: who they are and their workspaces, but no workspace.
    expect(await whoami()).toMatchObject({ person: { email: "ann@acme.test" }, workspaces: [{ id: personal }, { id: demo }] });
    expect(await whoami()).not.toHaveProperty("workspace");
    expect(await whoami(demo)).toMatchObject({ workspace: { id: demo, name: "demo" }, scope: "admin", path: `/w/${demo}/mcp` });
    expect(await whoami("Demo")).toMatchObject({ workspace: { id: demo } });
    const list = await fetch(`${base}/v1/workspaces`, { headers: as() }).then((r) => r.json());
    expect(list).toEqual({
      workspaces: [
        { id: personal, name: "ann's workspace", role: "admin" },
        { id: demo, name: "demo", role: "admin" },
      ],
    });

    // Anything else needs a workspace: never the console's active one.
    const unnamed = await fetch(`${base}/v1/components`, { headers: as() });
    expect(unnamed.status).toBe(400);
    expect(((await unnamed.json()) as { error: string }).error).toMatch(/2 workspaces.*app-mcp use/);
    expect((await fetch(`${base}/v1/components`, { headers: as(demo) })).status).toBe(200);
    await call(await console_(), "switch_workspace", { workspace: demo });
    expect(((await whoami(personal)) as { workspace: { id: string } }).workspace.id).toBe(personal);
    await call(await console_(), "switch_workspace", { workspace: personal });

    // Not someone else's workspace.
    const bob = await signUp("bob@other.test");
    const bobs = (await (await fetch(`${base}/workspaces`, { headers: { cookie: bob } })).json()) as { workspaces: { id: string }[] };
    expect((await fetch(`${base}/v1/components`, { headers: as(bobs.workspaces[0]!.id) })).status).toBe(404);

    // A workspace token stays on its workspace, whatever the request names.
    const ci = await store.createToken(demo, "publish", "ci");
    const ciAs = (workspace: string) => ({ authorization: `Bearer ${ci}`, "x-app-mcp-workspace": workspace });
    expect((await fetch(`${base}/v1/components`, { headers: ciAs("demo") })).status).toBe(200);
    expect((await fetch(`${base}/v1/components`, { headers: ciAs(personal) })).status).toBe(403);

    // Logout ends the person's token everywhere.
    expect((await fetch(`${base}/v1/tokens/current`, { method: "DELETE", headers: as() })).status).toBe(200);
    expect((await fetch(`${base}/v1/components`, { headers: as(demo) })).status).toBe(401);
  });

  it("lets an MCP connector act as the person and switch workspace like the console", async () => {
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

    // Two workspaces, and still no picker: straight to consent.
    const toConsent = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
    const consentUrl = new URL(toConsent.headers.get("location") ?? ((await toConsent.json()) as { url: string }).url, base);
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
    expect(await workspaceName(client)).toBe("ann's workspace");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_workspaces", "create_workspace", "switch_workspace"]));

    // The connector switches itself, and the console follows; the same token reaches both workspaces.
    await call(client, "switch_workspace", { workspace: demo });
    expect(await workspaceName(await connector(tokens.access_token))).toBe("demo");
    expect(await workspaceName(await console_())).toBe("demo");
    await call(await console_(), "switch_workspace", { workspace: personal });
    expect(await workspaceName(await connector(tokens.access_token))).toBe("ann's workspace");

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
    expect(await workspaceName(await connector(refreshed.access_token))).toBe("ann's workspace");
  });
});
