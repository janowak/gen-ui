import { Channel, ComponentManifest, MAX_BUNDLE_BYTES, Theme } from "@genui/format";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { RegistryError, type Scope, type Store } from "./store.js";

interface Caller {
  workspaceId: string;
  scope: Scope;
}

/** Which token scopes may call what. Admin can do everything. */
const ALLOWED: Record<Scope, Scope[]> = {
  server: ["server", "admin"],
  publish: ["publish", "admin"],
  admin: ["admin"],
};

const PublishBody = z.object({ manifest: ComponentManifest, html: z.string().min(1) });
const PromoteBody = z.object({ version: z.string().optional() });
const RollbackBody = z.object({ channel: Channel.default("stable") });
const TokenBody = z.object({ scope: z.enum(["server", "publish", "admin"]), name: z.string().min(1) });
const InviteBody = z.object({ email: z.email(), role: z.enum(["member", "admin"]).default("member") });

type Env = { Variables: { caller: Caller } };

/** Token-authenticated REST API used by the SDK (server), CI (publish) and the CLI (admin). */
export function createApi(store: Store): Hono<Env> {
  const api = new Hono<Env>();

  function auth(required: Scope) {
    return async (c: Context<Env>, next: Next) => {
      const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      const resolved = token ? store.resolveToken(token) : undefined;
      if (!resolved) return c.json({ error: "Invalid or missing token" }, 401);
      if (!ALLOWED[required].includes(resolved.scope)) {
        return c.json({ error: `Requires ${required === "admin" ? "an" : "a"} ${required} token (got ${resolved.scope})` }, 403);
      }
      c.set("caller", resolved);
      await next();
    };
  }

  const body = async (c: Context<Env>) => c.req.json().catch(() => ({}));
  const ws = (c: Context<Env>) => c.get("caller").workspaceId;

  // SDK: what to serve for a channel, plus the workspace theme.
  api.get("/catalog", auth("server"), (c) => c.json(store.catalog(ws(c), Channel.catch("stable").parse(c.req.query("channel")))));

  // SDK: immutable bundle by content hash.
  api.get("/bundles/:hash", auth("server"), (c) => {
    const html = store.bundle(ws(c), String(c.req.param("hash")));
    if (!html) return c.json({ error: "Bundle not found" }, 404);
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.html(html);
  });

  api.get("/components", auth("server"), (c) => c.json({ components: store.listComponents(ws(c)) }));

  // CI: publish a new immutable version; it lands on beta.
  api.post("/components", auth("publish"), async (c) => {
    const { manifest, html } = PublishBody.parse(await body(c));
    if (Buffer.byteLength(html) > MAX_BUNDLE_BYTES) throw new RegistryError(413, `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    if (!/<html[\s>]/i.test(html)) throw new RegistryError(400, "Bundle must be a single-file HTML document");
    return c.json({ ...store.publish(ws(c), manifest, html), channel: "beta" }, 201);
  });

  // Admin: beta → stable (or a specific version).
  api.post("/components/:name/promote", auth("admin"), async (c) => {
    const { version } = PromoteBody.parse(await body(c));
    const name = String(c.req.param("name"));
    return c.json({ name, channel: "stable", version: store.promote(ws(c), name, version) });
  });

  api.post("/components/:name/rollback", auth("admin"), async (c) => {
    const { channel } = RollbackBody.parse(await body(c));
    const name = String(c.req.param("name"));
    return c.json({ name, channel, version: store.rollback(ws(c), name, channel) });
  });

  api.get("/theme", auth("server"), (c) => c.json({ theme: store.getTheme(ws(c)) }));

  api.put("/theme", auth("admin"), async (c) => {
    const raw = (await body(c)) as { theme?: unknown };
    const theme = raw.theme === null ? null : Theme.parse(raw.theme);
    store.setTheme(ws(c), theme);
    return c.json({ theme });
  });

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
