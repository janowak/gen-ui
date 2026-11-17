import { describe, expect, it } from "vitest";
import { createRegistryApp, type Quotas, type RateLimiter, type RegistryAppOptions } from "./app.js";
import { loadAssets, testDatabase } from "./testing.js";

const QUOTAS: Quotas = {
  workspacesPerPerson: 2,
  environments: 2,
  components: 2,
  versionsPerDay: 3,
  workflows: 1,
  tokens: 2,
  pendingInvites: 1,
};

const html = (label: string) => `<!doctype html><html><body>${label}</body></html>`;
const manifest = (name: string, version: string) => ({ name, version, description: "A test component.", props: { type: "object", properties: {} } });
const workflow = (name: string) => ({ name, description: "Does a thing.", instructions: "Do it.", params: [] });
const hosted = { mode: "hosted" as const, adminEmails: [] };

/** A limiter that lets `allowed` requests per key through. */
function countingLimiter(allowed: number): RateLimiter {
  const counts = new Map<string, number>();
  return {
    async limit({ key }) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= allowed };
    },
  };
}

async function setup(options: Partial<RegistryAppOptions> = {}) {
  const { app, store } = createRegistryApp(await testDatabase(), { assets: await loadAssets(), quotas: QUOTAS, ...options });
  const workspace = await store.createWorkspace("acme");
  const admin = await store.createToken(workspace, "admin", "admin");
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, store, workspace, call };
}

describe("hosted quotas", () => {
  it("caps tokens, environments, invites and workflows per workspace", async () => {
    const { store, workspace } = await setup();
    await store.createToken(workspace, "publish", "ci");
    await expect(store.createToken(workspace, "server", "sdk")).rejects.toThrow(/at most 2 tokens/);

    await store.createEnvironment(workspace, "staging");
    await expect(store.createEnvironment(workspace, "preview")).rejects.toThrow(/at most 2 environments/);

    await store.invite(workspace, "a@example.com", "member");
    await store.invite(workspace, "A@example.com", "admin"); // the same invite again only changes its role
    await expect(store.invite(workspace, "b@example.com", "member")).rejects.toThrow(/at most 1 pending invites/);

    await store.saveWorkflow(workspace, "prod", workflow("returns"));
    await store.saveWorkflow(workspace, "prod", { ...workflow("returns"), instructions: "Do it again." });
    await expect(store.saveWorkflow(workspace, "prod", workflow("refunds"))).rejects.toThrow(/at most 1 workflows/);
    await store.saveWorkflow(workspace, "staging", workflow("refunds"));
  });

  it("caps component names and new versions a day; re-running a publish is free", async () => {
    const { call } = await setup();
    const publish = (name: string, version: string) => call("POST", "/v1/components", { manifest: manifest(name, version), html: html(version) });

    expect((await publish("rating", "1.0.0")).status).toBe(201);
    expect((await publish("rating", "1.0.0")).status).toBe(200);
    expect((await publish("survey", "1.0.0")).status).toBe(201);
    const third = await publish("poll", "1.0.0");
    expect(third.status).toBe(403);
    expect((await third.json()).error).toMatch(/at most 2 components/);

    expect((await publish("rating", "1.0.1")).status).toBe(201);
    const fourth = await publish("rating", "1.0.2");
    expect(fourth.status).toBe(403);
    expect((await fourth.json()).error).toMatch(/at most 3 new versions in 24 hours/);
    expect((await publish("rating", "1.0.1")).status).toBe(200);
  });

  it("caps the workspaces a person admins", async () => {
    const { store } = await setup();
    const user = { id: "u1", email: "kim@example.com", emailVerified: true };
    await store.resolveMembership(user, hosted);
    await store.createOwnWorkspace(user, "second", hosted);
    await expect(store.createOwnWorkspace(user, "third", hosted)).rejects.toThrow(/at most 2 workspaces/);
  });

  it("caps nothing without quotas (self-hosted)", async () => {
    const { store, workspace } = await setup({ quotas: undefined });
    for (const name of ["a", "b", "c"]) await store.createToken(workspace, "server", name);
  });
});

describe("rate limits", () => {
  it("limits changes per workspace, not reads", async () => {
    const { call } = await setup({ rateLimits: { writes: countingLimiter(1) } });
    expect((await call("POST", "/v1/environments", { name: "staging" })).status).toBe(201);
    const limited = await call("POST", "/v1/environments", { name: "preview" });
    expect(limited.status).toBe(429);
    expect((await call("GET", "/v1/environments")).status).toBe(200);
  });

  it("limits a workspace's end-user MCP", async () => {
    const { app } = await setup({ rateLimits: { endUserMcp: countingLimiter(1) } });
    const ping = () =>
      app.request("/w/acme/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    expect((await ping()).status).not.toBe(429);
    expect((await ping()).status).toBe(429);
  });
});
