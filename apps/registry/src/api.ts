import { Channel, ComponentManifest, MAX_BUNDLE_BYTES, Recipe, Theme } from "@genui/format";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import type { RegistryAppOptions } from "./app.js";
import { RegistryError, type Scope, type Store } from "./store.js";
import { webhookUrlError } from "./webhook.js";

interface Caller {
  workspaceId: string;
  scope: Scope;
}

/** Which token scopes may call what. Release can also publish; admin can do everything. */
export const ALLOWED: Record<Scope, Scope[]> = {
  server: ["server", "admin"],
  publish: ["publish", "release", "admin"],
  release: ["release", "admin"],
  admin: ["admin"],
};

const denied = (required: Scope, got: Scope) => `Requires ${required === "admin" ? "an" : "a"} ${required} token (got ${got})`;

const PublishBody = z.object({ manifest: ComponentManifest, html: z.string().min(1), channel: Channel.default("beta") });
const PromoteBody = z.object({ version: z.string().optional() });
const RollbackBody = z.object({ channel: Channel.default("stable") });
const TokenBody = z.object({ scope: z.enum(["server", "publish", "release", "admin"]), name: z.string().min(1) });
const InviteBody = z.object({ email: z.email(), role: z.enum(["member", "admin"]).default("member") });
const HostingBody = z.object({ enabled: z.boolean() });

type Env = { Variables: { caller: Caller } };

/** Token-authenticated REST API used by CI (publish, release) and the CLI (admin). Server tokens use the end-user MCP. */
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

  api.get("/components", auth("server"), (c) => c.json({ components: store.listComponents(ws(c)) }));

  // CI: publish an immutable version to beta, or with a release token straight to stable.
  // The same version with the same content again is a no-op (200), so jobs can be re-run.
  api.post("/components", auth("publish"), async (c) => {
    const { manifest, html, channel } = PublishBody.parse(await body(c));
    const { scope } = c.get("caller");
    if (channel === "stable" && !ALLOWED.release.includes(scope)) throw new RegistryError(403, denied("release", scope));
    if (Buffer.byteLength(html) > MAX_BUNDLE_BYTES) throw new RegistryError(413, `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    if (!/<html[\s>]/i.test(html)) throw new RegistryError(400, "Bundle must be a single-file HTML document");
    const result = store.publish(ws(c), manifest, html, channel);
    return c.json({ ...result, channel }, result.created ? 201 : 200);
  });

  // Release: beta → stable (or a specific version).
  api.post("/components/:name/promote", auth("release"), async (c) => {
    const { version } = PromoteBody.parse(await body(c));
    const name = String(c.req.param("name"));
    return c.json({ name, channel: "stable", version: store.promote(ws(c), name, version) });
  });

  api.post("/components/:name/rollback", auth("release"), async (c) => {
    const { channel } = RollbackBody.parse(await body(c));
    const name = String(c.req.param("name"));
    return c.json({ name, channel, version: store.rollback(ws(c), name, channel) });
  });

  api.get("/recipes", auth("server"), (c) => c.json({ recipes: store.listRecipes(ws(c)) }));

  // Admin (or CI with an admin token): recipes can live as JSON files in a repo.
  api.put("/recipes/:name", auth("admin"), async (c) => {
    const recipe = Recipe.parse({ ...((await body(c)) as object), name: String(c.req.param("name")) });
    const webhook = recipe.validate && webhookUrlError(recipe.validate.url, options.allowPrivateWebhooks);
    if (webhook) throw new RegistryError(400, webhook);
    const replaced = store.saveRecipe(ws(c), recipe);
    return c.json({ name: recipe.name, replaced }, replaced ? 200 : 201);
  });

  api.delete("/recipes/:name", auth("admin"), (c) => {
    store.deleteRecipe(ws(c), String(c.req.param("name")));
    return c.json({ deleted: c.req.param("name") });
  });

  api.get("/theme", auth("server"), (c) => c.json({ theme: store.getTheme(ws(c)) }));

  api.put("/theme", auth("admin"), async (c) => {
    const raw = (await body(c)) as { theme?: unknown };
    const theme = raw.theme === null ? null : Theme.parse(raw.theme);
    store.setTheme(ws(c), theme);
    return c.json({ theme });
  });

  // Admin: serve the workspace's end-user MCP from the registry, for companies without their own MCP server.
  const hosting = (workspaceId: string) => ({
    hosted: store.isHosted(workspaceId),
    paths: { stable: `/w/${workspaceId}/mcp`, beta: `/w/${workspaceId}/beta/mcp` },
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
    const { scope, name } = TokenBody.parse(await body(c));
    return c.json({ token: store.createToken(ws(c), scope, name), scope }, 201);
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
