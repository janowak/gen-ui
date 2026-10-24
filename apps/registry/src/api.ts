import { ComponentManifest, DEFAULT_ENVIRONMENT, EnvironmentName, MAX_BUNDLE_BYTES, Recipe, SEMVER, Theme } from "@genui/format";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import type { RegistryAppOptions } from "./app.js";
import { RegistryError, type Scope, type Store, type TokenInfo } from "./store.js";
import { webhookUrlError } from "./webhook.js";

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

const PublishBody = z.object({ manifest: ComponentManifest, html: z.string().min(1), environment: EnvironmentName.default(DEFAULT_ENVIRONMENT) });
const DeployBody = z.object({ version: z.string().regex(SEMVER, "x.y.z") });
const EnvironmentBody = z.object({ name: EnvironmentName });
const TokenBody = z.object({
  scope: z.enum(["server", "publish", "admin"]),
  name: z.string().min(1),
  environments: z.array(EnvironmentName).min(1).optional(),
});
const InviteBody = z.object({ email: z.email(), role: z.enum(["member", "admin"]).default("member") });
const HostingBody = z.object({ enabled: z.boolean() });

type Env = { Variables: { caller: TokenInfo } };

/** Token-authenticated REST API used by CI (publish) and the CLI (admin). Server tokens use the end-user MCP. */
export function createApi(store: Store, options: RegistryAppOptions = {}): Hono<Env> {
  const api = new Hono<Env>();

  function auth(required: Scope) {
    return async (c: Context<Env>, next: Next) => {
      const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      const resolved = token ? store.resolveToken(token) : undefined;
      if (!resolved) return c.json({ error: "Invalid or missing token" }, 401);
      if (!ALLOWED[required].includes(resolved.scope)) return c.json({ error: denied(required, resolved.scope) }, 403);
      c.set("caller", resolved);
      await next();
    };
  }

  const body = async (c: Context<Env>) => c.req.json().catch(() => ({}));
  const ws = (c: Context<Env>) => c.get("caller").workspaceId;

  /** The environment a recipe or theme request targets: `?environment=`, default prod. */
  function environment(c: Context<Env>): string {
    const name = EnvironmentName.parse(c.req.query("environment") ?? DEFAULT_ENVIRONMENT);
    store.requireEnvironment(ws(c), name);
    return name;
  }

  /** Publish tokens can be limited to some environments; admin tokens reach all of them. */
  function allowPublish(c: Context<Env>, environment: string) {
    const allowed = c.get("caller").environments;
    if (allowed && !allowed.includes(environment)) throw new RegistryError(403, `This token can't publish to ${environment} (allowed: ${allowed.join(", ")})`);
  }

  api.get("/components", auth("server"), (c) => c.json({ components: store.listComponents(ws(c)) }));

  // CI: publish an immutable version and point an environment (default prod) at it, older versions included.
  // The same version with the same content again is a no-op (200), so jobs can be re-run.
  api.post("/components", auth("publish"), async (c) => {
    const { manifest, html, environment } = PublishBody.parse(await body(c));
    allowPublish(c, environment);
    if (Buffer.byteLength(html) > MAX_BUNDLE_BYTES) throw new RegistryError(413, `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    if (!/<html[\s>]/i.test(html)) throw new RegistryError(400, "Bundle must be a single-file HTML document");
    const result = store.publish(ws(c), manifest, html, environment);
    return c.json(result, result.created ? 201 : 200);
  });

  // CI: point an environment at a version that's already published, without rebuilding it.
  api.put("/components/:name/environments/:environment", auth("publish"), async (c) => {
    const environment = EnvironmentName.parse(c.req.param("environment"));
    allowPublish(c, environment);
    const { version } = DeployBody.parse(await body(c));
    return c.json(store.deployVersion(ws(c), String(c.req.param("name")), version, environment));
  });

  // Environments: each serves what was last published or saved to it, at its own end-user MCP.
  api.get("/environments", auth("server"), (c) =>
    c.json({ environments: store.listEnvironments(ws(c)).map((name) => ({ name, path: endUserPath(ws(c), name) })) }),
  );

  api.post("/environments", auth("admin"), async (c) => {
    const { name } = EnvironmentBody.parse(await body(c));
    store.createEnvironment(ws(c), name);
    return c.json({ name, path: endUserPath(ws(c), name) }, 201);
  });

  api.delete("/environments/:name", auth("admin"), (c) => {
    store.deleteEnvironment(ws(c), String(c.req.param("name")));
    return c.json({ deleted: c.req.param("name") });
  });

  api.get("/recipes", auth("server"), (c) => c.json({ recipes: store.listRecipes(ws(c), environment(c)) }));

  // Admin (or CI with an admin token): recipes can live as JSON files in a repo.
  api.put("/recipes/:name", auth("admin"), async (c) => {
    const target = environment(c);
    const recipe = Recipe.parse({ ...((await body(c)) as object), name: String(c.req.param("name")) });
    const webhook = recipe.validate && webhookUrlError(recipe.validate.url, options.allowPrivateWebhooks);
    if (webhook) throw new RegistryError(400, webhook);
    const replaced = store.saveRecipe(ws(c), target, recipe);
    return c.json({ name: recipe.name, environment: target, replaced }, replaced ? 200 : 201);
  });

  api.delete("/recipes/:name", auth("admin"), (c) => {
    store.deleteRecipe(ws(c), environment(c), String(c.req.param("name")));
    return c.json({ deleted: c.req.param("name") });
  });

  api.get("/theme", auth("server"), (c) => c.json({ theme: store.getTheme(ws(c), environment(c)) }));

  api.put("/theme", auth("admin"), async (c) => {
    const target = environment(c);
    const raw = (await body(c)) as { theme?: unknown };
    const theme = raw.theme === null ? null : Theme.parse(raw.theme);
    store.setTheme(ws(c), target, theme);
    return c.json({ environment: target, theme });
  });

  // Admin: serve the workspace's end-user MCP from the registry, for companies without their own MCP server.
  const hosting = (workspaceId: string) => ({
    hosted: store.isHosted(workspaceId),
    paths: Object.fromEntries(store.listEnvironments(workspaceId).map((name) => [name, endUserPath(workspaceId, name)])),
  });

  api.get("/hosting", auth("admin"), (c) => c.json(hosting(ws(c))));

  api.put("/hosting", auth("admin"), async (c) => {
    const { enabled } = HostingBody.parse(await body(c));
    store.setHosted(ws(c), enabled);
    return c.json(hosting(ws(c)));
  });

  // Admin: the secret recipe validation webhooks are signed with (x-genui-signature). POST replaces it.
  api.get("/hosting/webhook-secret", auth("admin"), (c) => c.json({ secret: store.webhookSecret(ws(c)) }));
  api.post("/hosting/webhook-secret", auth("admin"), (c) => c.json({ secret: store.rotateWebhookSecret(ws(c)) }));

  api.post("/tokens", auth("admin"), async (c) => {
    const { scope, name, environments } = TokenBody.parse(await body(c));
    if (environments && scope !== "publish") throw new RegistryError(400, "Only publish tokens can be limited to environments");
    return c.json({ token: store.createToken(ws(c), scope, name, environments), scope, ...(environments ? { environments } : {}) }, 201);
  });

  // Admin: let someone manage this workspace from their AI assistant; claimed at their first sign-in.
  api.post("/invites", auth("admin"), async (c) => {
    const { email, role } = InviteBody.parse(await body(c));
    store.invite(ws(c), email, role);
    return c.json({ email, role }, 201);
  });

  api.onError((error, c) => {
    if (error instanceof RegistryError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", issues: error.issues }, 400);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  return api;
}
