import { componentMetadata } from "@app-mcp/format";
import { contentHash } from "@app-mcp/runtime";
import { externalize } from "./static-assets.js";
import {
  Branding,
  PublishManifest,
  DEFAULT_ENVIRONMENT,
  EnvironmentName,
  MAX_BUNDLE_BYTES,
  MAX_PUBLISH_BYTES,
  MAX_ENVIRONMENT_INSTRUCTIONS,
  MAX_ICON_BYTES,
  SEMVER,
  Theme,
  Workflow,
} from "@app-mcp/format";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import type { RegistryAppOptions } from "./app.js";
import { RegistryError, type EnvironmentInfo, type Scope, type Store, type TokenInfo, type WorkspaceSummary } from "./store.js";
import { refreshUrlError } from "./url.js";

/** Which token scopes may call what. Admin can do everything. */
export const ALLOWED: Record<Scope, Scope[]> = {
  server: ["server", "admin"],
  publish: ["publish", "admin"],
  admin: ["admin"],
};

/** Where an environment's end-user MCP lives: prod at the workspace's root path. */
export const endUserPath = (workspaceId: string, environment: string) =>
  environment === DEFAULT_ENVIRONMENT ? `/w/${workspaceId}/mcp` : `/w/${workspaceId}/${environment}/mcp`;

const denied = (required: Scope, got: Scope) => `Requires ${required === "admin" ? "an" : "a"} ${required} token (got ${got})`;

const PublishBody = z.object({
  manifest: PublishManifest,
  html: z.string().min(1),
  environment: EnvironmentName.default(DEFAULT_ENVIRONMENT),
});
const DeployBody = z.object({ version: z.string().regex(SEMVER, "x.y.z") });
const EnvironmentBody = z.object({ name: EnvironmentName });
const EnvironmentSettingsBody = z.object({ refreshUrl: z.url().nullable().optional(), builtIns: z.boolean().optional() });
const TokenBody = z.object({
  scope: z.enum(["server", "publish", "admin"]),
  name: z.string().min(1),
  environments: z.array(EnvironmentName).min(1).optional(),
});
const HostingBody = z.object({ enabled: z.boolean() });
const InstructionsBody = z.object({ instructions: z.string().max(MAX_ENVIRONMENT_INSTRUCTIONS).nullable() });

/** How a request made with a person token (`app-mcp login`) names its workspace: an id or a name. */
export const WORKSPACE_HEADER = "x-app-mcp-workspace";

/**
 * Who is calling, in one workspace. A workspace token (CI, servers) is bound to its workspace. A person
 * token reaches every workspace the person is in, with their role there read on every request: admins
 * get admin, members read-only.
 */
type Caller = TokenInfo & { person?: { userId: string; workspaceName: string } };
type Env = { Variables: { caller: Caller } };

const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

/** Token-authenticated REST API used by CI (publish) and the CLI. Server tokens use the end-user MCP. */
export function createApi(store: Store, options: Pick<RegistryAppOptions, "allowPrivateWebhooks" | "staticHosting"> = {}): Hono<Env> {
  const api = new Hono<Env>();

  /**
   * The person's workspace a request names, or their only one. Never the console's active workspace: a
   * switch in the browser mustn't move where a terminal publishes.
   */
  async function personWorkspace(userId: string, named: string | undefined): Promise<WorkspaceSummary> {
    const workspaces = await store.listWorkspaces(userId);
    if (!workspaces.length) throw new RegistryError(403, "You aren't in any app-mcp workspace. Ask an admin to invite your email.");
    if (named) {
      const byId = workspaces.find((w) => w.id === named);
      const byName = workspaces.filter((w) => w.name.toLowerCase() === named.toLowerCase());
      if (byId) return byId;
      if (byName.length === 1) return byName[0]!;
      if (byName.length > 1)
        throw new RegistryError(400, `You're in several workspaces called "${named}". Name one by id: app-mcp workspaces`);
      throw new RegistryError(404, `You aren't in a workspace called "${named}". app-mcp workspaces lists yours.`);
    }
    if (workspaces.length === 1) return workspaces[0]!;
    throw new RegistryError(
      400,
      `You're in ${workspaces.length} workspaces (${workspaces.map((w) => w.name).join(", ")}). ` +
        "Pick one with app-mcp use <workspace>, or pass --workspace.",
    );
  }

  async function resolveCaller(c: Context<Env>): Promise<Caller | undefined> {
    const token = bearer(c);
    if (!token) return undefined;
    const named = c.req.header(WORKSPACE_HEADER) || undefined;
    const person = await store.resolvePersonToken(token);
    if (person) {
      const workspace = await personWorkspace(person.userId, named);
      return {
        id: person.id,
        workspaceId: workspace.id,
        scope: workspace.role === "admin" ? "admin" : "server",
        environments: null,
        person: { userId: person.userId, workspaceName: workspace.name },
      };
    }
    const resolved = await store.resolveToken(token);
    // A workspace token only reaches its own workspace, whatever the request names.
    if (resolved && named && named !== resolved.workspaceId) {
      const workspace = await store.workspace(resolved.workspaceId);
      if (named.toLowerCase() !== workspace?.name.toLowerCase())
        throw new RegistryError(403, `This token is for the ${workspace?.name ?? resolved.workspaceId} workspace, not ${named}.`);
    }
    return resolved;
  }

  function auth(required: Scope, scopes = ALLOWED[required]) {
    return async (c: Context<Env>, next: Next) => {
      const resolved = await resolveCaller(c);
      if (!resolved) return c.json({ error: "Invalid or missing token" }, 401);
      if (!scopes.includes(resolved.scope))
        return c.json(
          {
            error: resolved.person
              ? `Only admins of ${resolved.person.workspaceName} can do this; you're a member there.`
              : denied(required, resolved.scope),
          },
          403,
        );
      c.set("caller", resolved);
      await next();
    };
  }

  /** What's served where: every token may read it, so `app-mcp list` works with the publish token that published. */
  const anyToken = () => auth("server", ["server", "publish", "admin"]);

  const body = async (c: Context<Env>) => c.req.json().catch(() => ({}));
  const ws = (c: Context<Env>) => c.get("caller").workspaceId;

  /** The environment a workflow, theme or instructions request targets: `?environment=`, default prod. */
  async function environment(c: Context<Env>): Promise<string> {
    const name = EnvironmentName.parse(c.req.query("environment") ?? DEFAULT_ENVIRONMENT);
    await store.requireEnvironment(ws(c), name);
    return name;
  }

  /** Publish tokens can be limited to some environments; admin tokens reach all of them. */
  function allowPublish(c: Context<Env>, environment: string) {
    const allowed = c.get("caller").environments;
    if (allowed && !allowed.includes(environment))
      throw new RegistryError(403, `This token can't publish to ${environment} (allowed: ${allowed.join(", ")})`);
  }

  // A person token's own routes: they work without naming a workspace.
  async function person(c: Context<Env>) {
    const token = bearer(c);
    return token ? store.resolvePersonToken(token) : undefined;
  }

  // The person's workspaces: `app-mcp workspaces`, and what `app-mcp use` picks from.
  api.get("/workspaces", async (c) => {
    const signedIn = await person(c);
    if (!signedIn) return c.json({ error: "Requires the token from app-mcp login" }, 401);
    return c.json({ workspaces: (await store.listWorkspaces(signedIn.userId)).map(({ id, name, role }) => ({ id, name, role })) });
  });

  // Who a token is: `app-mcp whoami`, and how an agent checks it is signed in before it starts. A person
  // in several workspaces who named none gets them all, and no workspace.
  api.get("/whoami", async (c) => {
    const signedIn = await person(c);
    const user = signedIn && (await store.user(signedIn.userId));
    const me = user ? { person: { email: user.email, name: user.name ?? null } } : {};
    const workspaces = signedIn && (await store.listWorkspaces(signedIn.userId)).map(({ id, name, role }) => ({ id, name, role }));
    if (signedIn && !c.req.header(WORKSPACE_HEADER) && workspaces!.length !== 1) return c.json({ ...me, workspaces });
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: "Invalid or missing token" }, 401);
    const { workspaceId, scope, environments } = caller;
    const workspace = await store.workspace(workspaceId);
    return c.json({
      ...me,
      workspace: { id: workspaceId, name: workspace?.name ?? workspaceId },
      scope,
      ...(environments ? { environments } : {}),
      path: endUserPath(workspaceId, DEFAULT_ENVIRONMENT),
      ...(workspaces ? { workspaces } : {}),
    });
  });

  api.get("/components", anyToken(), async (c) => c.json({ components: await store.listComponents(ws(c)) }));

  // CI: publish an immutable version and point an environment (default prod) at it, older versions included.
  // The same version with the same content again is a no-op (200), so jobs can be re-run.
  api.post("/components", auth("publish"), async (c) => {
    const { manifest, html, environment } = PublishBody.parse(await body(c));
    allowPublish(c, environment);
    const limit = options.staticHosting ? MAX_PUBLISH_BYTES : MAX_BUNDLE_BYTES;
    if (new TextEncoder().encode(html).byteLength > limit) throw new RegistryError(413, `Bundle exceeds ${limit} bytes`);
    if (!/<html[\s>]/i.test(html)) throw new RegistryError(400, "Bundle must be a single-file HTML document");
    await store.requireEnvironment(ws(c), environment);
    const resource = options.staticHosting ? await externalize(html, options.staticHosting) : { html };
    if (new TextEncoder().encode(resource.html).byteLength > MAX_BUNDLE_BYTES)
      throw new RegistryError(413, `HTML shell exceeds ${MAX_BUNDLE_BYTES} bytes; move large inline markup into scripts or styles`);
    const result = await store.publish(
      ws(c),
      manifest,
      resource.html,
      environment,
      componentMetadata(manifest.csp, resource._meta),
      contentHash(html),
    );
    return c.json(result, result.created ? 201 : 200);
  });

  // CI: point an environment at a version that's already published, without rebuilding it.
  api.put("/components/:name/environments/:environment", auth("publish"), async (c) => {
    const environment = EnvironmentName.parse(c.req.param("environment"));
    allowPublish(c, environment);
    const { version } = DeployBody.parse(await body(c));
    return c.json(await store.deployVersion(ws(c), String(c.req.param("name")), version, environment));
  });

  // Stop serving a component in an environment; its versions stay published.
  api.delete("/components/:name/environments/:environment", auth("publish"), async (c) => {
    const environment = EnvironmentName.parse(c.req.param("environment"));
    allowPublish(c, environment);
    const name = String(c.req.param("name"));
    await store.removeComponent(ws(c), name, environment);
    return c.json({ removed: name, environment });
  });

  // Environments: each serves what was last published or saved to it, at its own end-user MCP.
  const describe = (workspaceId: string, info: EnvironmentInfo) => ({ ...info, path: endUserPath(workspaceId, info.name) });

  api.get("/environments", anyToken(), async (c) =>
    c.json({ environments: (await store.listEnvironmentInfo(ws(c))).map((info) => describe(ws(c), info)) }),
  );

  // Admin: the company server's refresh endpoint (@app-mcp/sdk), called after every change to what the environment
  // serves, and whether the built-in render_form and render_chart are on. Settings left out stay as they are.
  api.put("/environments/:name", auth("admin"), async (c) => {
    const name = String(c.req.param("name"));
    const { refreshUrl, builtIns } = EnvironmentSettingsBody.parse(await body(c));
    const invalid = refreshUrl && refreshUrlError(refreshUrl, options.allowPrivateWebhooks);
    if (invalid) throw new RegistryError(400, invalid);
    if (refreshUrl !== undefined) await store.setRefreshUrl(ws(c), name, refreshUrl);
    if (builtIns !== undefined) await store.setBuiltIns(ws(c), name, builtIns);
    await store.requireEnvironment(ws(c), name);
    return c.json(describe(ws(c), (await store.environment(ws(c), name))!));
  });

  api.post("/environments", auth("admin"), async (c) => {
    const { name } = EnvironmentBody.parse(await body(c));
    await store.createEnvironment(ws(c), name);
    return c.json({ name, path: endUserPath(ws(c), name) }, 201);
  });

  api.delete("/environments/:name", auth("admin"), async (c) => {
    await store.deleteEnvironment(ws(c), String(c.req.param("name")));
    return c.json({ deleted: c.req.param("name") });
  });

  api.get("/workflows", auth("server"), async (c) => c.json({ workflows: await store.listWorkflows(ws(c), await environment(c)) }));

  // CI publishes workflows from the repo next to the components they use, with the same tokens.
  api.put("/workflows/:name", auth("publish"), async (c) => {
    const target = await environment(c);
    allowPublish(c, target);
    const workflow = Workflow.parse({ ...((await body(c)) as object), name: String(c.req.param("name")) });
    const replaced = await store.saveWorkflow(ws(c), target, workflow);
    return c.json({ name: workflow.name, environment: target, command: workflow.params.length > 0, replaced }, replaced ? 200 : 201);
  });

  api.delete("/workflows/:name", auth("publish"), async (c) => {
    const target = await environment(c);
    allowPublish(c, target);
    await store.deleteWorkflow(ws(c), target, String(c.req.param("name")));
    return c.json({ deleted: c.req.param("name") });
  });

  api.get("/theme", auth("server"), async (c) => c.json({ theme: await store.getTheme(ws(c), await environment(c)) }));

  api.put("/theme", auth("admin"), async (c) => {
    const target = await environment(c);
    const raw = (await body(c)) as { theme?: unknown };
    const theme = raw.theme === null ? null : Theme.parse(raw.theme);
    await store.setTheme(ws(c), target, theme);
    return c.json({ environment: target, theme });
  });

  // What the environment's MCP helps with; hosts get it with the workflows added.
  api.get("/instructions", auth("server"), async (c) => {
    const target = await environment(c);
    return c.json({ environment: target, instructions: await store.getInstructions(ws(c), target) });
  });

  api.put("/instructions", auth("admin"), async (c) => {
    const target = await environment(c);
    const { instructions } = InstructionsBody.parse(await body(c));
    await store.setInstructions(ws(c), target, instructions);
    return c.json({ environment: target, instructions: await store.getInstructions(ws(c), target) });
  });

  // How the workspace's end-user MCP presents itself: title, description, website and icon.
  api.get("/branding", auth("server"), async (c) => c.json(await store.branding(ws(c))));

  api.put("/branding", auth("admin"), async (c) => {
    await store.setBranding(ws(c), Branding.parse(await body(c)));
    return c.json(await store.branding(ws(c)));
  });

  // The raw image as the body (PNG, JPEG, WebP or SVG); its format is read from the bytes.
  api.put("/branding/icon", auth("admin"), async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) throw new RegistryError(400, "Send the icon image as the request body");
    if (bytes.byteLength > MAX_ICON_BYTES) throw new RegistryError(413, `The icon is over ${MAX_ICON_BYTES / 1000} KB`);
    await store.setIcon(ws(c), bytes);
    return c.json(await store.branding(ws(c)));
  });

  api.delete("/branding/icon", auth("admin"), async (c) => {
    await store.setIcon(ws(c), null);
    return c.json(await store.branding(ws(c)));
  });

  // Admin: serve the workspace's end-user MCP from the registry, for companies without their own MCP server.
  const hosting = async (workspaceId: string) => ({
    hosted: await store.isHosted(workspaceId),
    paths: Object.fromEntries((await store.listEnvironments(workspaceId)).map((name) => [name, endUserPath(workspaceId, name)])),
  });

  api.get("/hosting", auth("admin"), async (c) => c.json(await hosting(ws(c))));

  api.put("/hosting", auth("admin"), async (c) => {
    const { enabled } = HostingBody.parse(await body(c));
    await store.setHosted(ws(c), enabled);
    return c.json(await hosting(ws(c)));
  });

  api.post("/tokens", auth("admin"), async (c) => {
    const { scope, name, environments } = TokenBody.parse(await body(c));
    if (environments && scope !== "publish") throw new RegistryError(400, "Only publish tokens can be limited to environments");
    return c.json(
      { token: await store.createToken(ws(c), scope, name, environments), scope, ...(environments ? { environments } : {}) },
      201,
    );
  });

  // `app-mcp logout`: a token ends itself, so a signed-out machine leaves nothing that still works.
  api.delete("/tokens/current", async (c, next) => {
    const signedIn = await person(c);
    if (!signedIn) return next();
    await store.revokePersonToken(signedIn.id);
    return c.json({ revoked: true });
  });
  api.delete("/tokens/current", anyToken(), async (c) => {
    await store.revokeToken(ws(c), c.get("caller").id);
    return c.json({ revoked: true });
  });

  api.onError((error, c) => {
    if (error instanceof RegistryError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", issues: error.issues }, 400);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  return api;
}
