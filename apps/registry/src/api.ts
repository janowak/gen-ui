import { Branding, ComponentManifest, DEFAULT_ENVIRONMENT, EnvironmentName, Guide, MAX_BUNDLE_BYTES, MAX_ICON_BYTES, Recipe, SEMVER, Theme } from "@genui/format";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import type { RegistryAppOptions } from "./app.js";
import { RegistryError, type EnvironmentInfo, type Scope, type Store, type TokenInfo } from "./store.js";
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
const EnvironmentSettingsBody = z.object({ refreshUrl: z.url().nullable() });
const TokenBody = z.object({
  scope: z.enum(["server", "publish", "admin"]),
  name: z.string().min(1),
  environments: z.array(EnvironmentName).min(1).optional(),
});
const HostingBody = z.object({ enabled: z.boolean() });

type Env = { Variables: { caller: TokenInfo } };

/** Token-authenticated REST API used by CI (publish) and the CLI (admin). Server tokens use the end-user MCP. */
export function createApi(store: Store, options: Pick<RegistryAppOptions, "allowPrivateWebhooks"> = {}): Hono<Env> {
  const api = new Hono<Env>();

  function auth(required: Scope) {
    return async (c: Context<Env>, next: Next) => {
      const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      const resolved = token ? await store.resolveToken(token) : undefined;
      if (!resolved) return c.json({ error: "Invalid or missing token" }, 401);
      if (!ALLOWED[required].includes(resolved.scope)) return c.json({ error: denied(required, resolved.scope) }, 403);
      c.set("caller", resolved);
      await next();
    };
  }

  const body = async (c: Context<Env>) => c.req.json().catch(() => ({}));
  const ws = (c: Context<Env>) => c.get("caller").workspaceId;

  /** The environment a recipe or theme request targets: `?environment=`, default prod. */
  async function environment(c: Context<Env>): Promise<string> {
    const name = EnvironmentName.parse(c.req.query("environment") ?? DEFAULT_ENVIRONMENT);
    await store.requireEnvironment(ws(c), name);
    return name;
  }

  /** Publish tokens can be limited to some environments; admin tokens reach all of them. */
  function allowPublish(c: Context<Env>, environment: string) {
    const allowed = c.get("caller").environments;
    if (allowed && !allowed.includes(environment)) throw new RegistryError(403, `This token can't publish to ${environment} (allowed: ${allowed.join(", ")})`);
  }

  api.get("/components", auth("server"), async (c) => c.json({ components: await store.listComponents(ws(c)) }));

  // CI: publish an immutable version and point an environment (default prod) at it, older versions included.
  // The same version with the same content again is a no-op (200), so jobs can be re-run.
  api.post("/components", auth("publish"), async (c) => {
    const { manifest, html, environment } = PublishBody.parse(await body(c));
    allowPublish(c, environment);
    if (new TextEncoder().encode(html).byteLength > MAX_BUNDLE_BYTES) throw new RegistryError(413, `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    if (!/<html[\s>]/i.test(html)) throw new RegistryError(400, "Bundle must be a single-file HTML document");
    const result = await store.publish(ws(c), manifest, html, environment);
    return c.json(result, result.created ? 201 : 200);
  });

  // CI: point an environment at a version that's already published, without rebuilding it.
  api.put("/components/:name/environments/:environment", auth("publish"), async (c) => {
    const environment = EnvironmentName.parse(c.req.param("environment"));
    allowPublish(c, environment);
    const { version } = DeployBody.parse(await body(c));
    return c.json(await store.deployVersion(ws(c), String(c.req.param("name")), version, environment));
  });

  // Environments: each serves what was last published or saved to it, at its own end-user MCP.
  const describe = (workspaceId: string, info: EnvironmentInfo) => ({ ...info, path: endUserPath(workspaceId, info.name) });

  api.get("/environments", auth("server"), async (c) => c.json({ environments: (await store.listEnvironmentInfo(ws(c))).map((info) => describe(ws(c), info)) }));

  // Admin: the company server's refresh endpoint (@genui/sdk), called after every change to what the environment serves.
  api.put("/environments/:name", auth("admin"), async (c) => {
    const name = String(c.req.param("name"));
    const { refreshUrl } = EnvironmentSettingsBody.parse(await body(c));
    const invalid = refreshUrl && webhookUrlError(refreshUrl, options.allowPrivateWebhooks, "refresh URL");
    if (invalid) throw new RegistryError(400, invalid);
    await store.setRefreshUrl(ws(c), name, refreshUrl);
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

  api.get("/recipes", auth("server"), async (c) => c.json({ recipes: await store.listRecipes(ws(c), await environment(c)) }));

  // Admin (or CI with an admin token): recipes can live as JSON files in a repo.
  api.put("/recipes/:name", auth("admin"), async (c) => {
    const target = await environment(c);
    const recipe = Recipe.parse({ ...((await body(c)) as object), name: String(c.req.param("name")) });
    const webhook = recipe.validate && webhookUrlError(recipe.validate.url, options.allowPrivateWebhooks);
    if (webhook) throw new RegistryError(400, webhook);
    const replaced = await store.saveRecipe(ws(c), target, recipe);
    return c.json({ name: recipe.name, environment: target, replaced }, replaced ? 200 : 201);
  });

  api.delete("/recipes/:name", auth("admin"), async (c) => {
    await store.deleteRecipe(ws(c), await environment(c), String(c.req.param("name")));
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

  // Instructions and workflow prompts the environment's end-user MCP gives hosts.
  api.get("/guide", auth("server"), async (c) => c.json({ environment: await environment(c), ...(await store.getGuide(ws(c), await environment(c))) }));

  api.put("/guide", auth("admin"), async (c) => {
    const target = await environment(c);
    const guide = Guide.parse(await body(c));
    await store.setGuide(ws(c), target, guide);
    return c.json({ environment: target, ...guide });
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

  // Admin: the secret recipe validation webhooks are signed with (x-genui-signature). POST replaces it.
  api.get("/hosting/webhook-secret", auth("admin"), async (c) => c.json({ secret: await store.webhookSecret(ws(c)) }));
  api.post("/hosting/webhook-secret", auth("admin"), async (c) => c.json({ secret: await store.rotateWebhookSecret(ws(c)) }));

  api.post("/tokens", auth("admin"), async (c) => {
    const { scope, name, environments } = TokenBody.parse(await body(c));
    if (environments && scope !== "publish") throw new RegistryError(400, "Only publish tokens can be limited to environments");
    return c.json({ token: await store.createToken(ws(c), scope, name, environments), scope, ...(environments ? { environments } : {}) }, 201);
  });

  api.onError((error, c) => {
    if (error instanceof RegistryError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", issues: error.issues }, 400);
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  return api;
}
