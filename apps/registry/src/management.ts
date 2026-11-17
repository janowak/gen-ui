import { requireMcpAuth } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { enableCliLogin, isCliPath } from "./cli-login.js";
import { createAuth, createWorkspace, resolveMembership, signInOptions, type Auth, type AuthConfig, type MetadataFetch } from "./auth.js";
import type { Database } from "./db.js";
import { z } from "zod";
import { createRegistryMcp, type WorkspaceAccess } from "./mcp.js";
import { RegistryError, type Membership, type Store } from "./store.js";
import type { Assets } from "./views.js";

/** What management needs from the runtime it runs on. */
export interface ManagementRuntime {
  assets: Assets;
  fetchClientMetadataResource: MetadataFetch;
}

/**
 * Management in chat: better-auth (OAuth for MCP clients, sign-in, consent) plus the
 * registry MCP at /mcp. Tokens are bound to `${baseURL}/mcp`; the person's role is read
 * from the database on every request, so role changes apply immediately.
 * The web console at /manage serves the same MCP and views to a browser signed in with a session,
 * and /cli signs the app-mcp CLI in from that session.
 */
export function enableManagement(
  app: Hono,
  db: Database,
  store: Store,
  config: AuthConfig,
  { assets, fetchClientMetadataResource }: ManagementRuntime,
): Auth {
  const auth = createAuth(db, store, config, fetchClientMetadataResource);
  // /mcp checks access tokens against the keys that signed them, read in-process. Over HTTP it would
  // fetch our own public URL, which a Worker can't (same-domain fetch fails) and a container behind a
  // proxy may not. better-auth's verifier takes a key-set function here (core's JwksFetchOptions);
  // only requireMcpAuth's type says URL. The management tests cover this on both runtimes.
  const jwks = (() => auth.api.getJwks()) as unknown as string;
  const resource = `${config.baseURL}/mcp`;

  // Browser-based MCP clients (MCP Inspector, the playground) call these cross-origin. They use bearer
  // tokens / PKCE, never cookies, so CORS stays credential-less. Session endpoints get no CORS.
  const publicCors = cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
    exposeHeaders: ["www-authenticate", "mcp-session-id"],
  });
  for (const path of ["/mcp", "/.well-known/*", "/api/auth/oauth2/token", "/api/auth/oauth2/register", "/api/auth/jwks"])
    app.use(path, publicCors);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Discovery at the root paths MCP clients derive from the resource (RFC 9728) and issuer (RFC 8414).
  // The mcp plugin answers the protected-resource paths itself when given the original request.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, (c) => auth.handler(c.req.raw));
  }
  const authServerMetadata = oauthProviderAuthServerMetadata(auth);
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);
  for (const suffix of ["", "/api/auth"]) {
    app.get(`/.well-known/oauth-authorization-server${suffix}`, (c) => authServerMetadata(c.req.raw));
    app.get(`/.well-known/openid-configuration${suffix}`, (c) => openIdMetadata(c.req.raw));
  }

  const session = (request: Request) => auth.api.getSession({ headers: request.headers });

  // Sign-in and consent pages (better-auth's client resumes the OAuth flow from them). A sign-in that
  // isn't part of an OAuth flow (no signed query) is for the web console, so a session goes straight there.
  app.get("/sign-in", async (c) => {
    const next = c.req.query("next");
    if (!c.req.query("sig") && (await session(c.req.raw))) return c.redirect(isCliPath(next) ? next : "/manage");
    return c.html(assets.pages["sign-in"]);
  });
  app.get("/consent", (c) => c.html(assets.pages.consent));
  app.get("/auth/options", (c) => c.json(signInOptions(config)));

  // `app-mcp login`: an admin allows the CLI from the browser and it gets a token, with no secret to copy.
  enableCliLogin(app, store, config, assets.pages.cli, session);

  // The verified membership travels in authInfo.extra; the handler never reads it from headers.
  // A switch of environment changes the preview tools: open listen streams re-list.
  // The handler answers a failure with a bare "Internal server error"; onerror is the only place the cause shows.
  const mcp = createMcpHandler(
    (ctx) => {
      const { member, workspaces } = ctx.authInfo!.extra as { member: Membership; workspaces: WorkspaceAccess };
      return createRegistryMcp(store, member, { baseURL: config.baseURL, assets, workspaces }, () => {
        mcp.notify.toolsChanged();
        mcp.notify.resourcesChanged();
      });
    },
    { onerror: (error) => console.error("[app-mcp] management MCP:", error) },
  );

  /** The person's workspaces as the management MCP offers them, in the console and in connectors alike. */
  const workspaceAccess = (userId: string): WorkspaceAccess => ({
    list: () => store.listWorkspaces(userId),
    // A self-hosted registry has a single workspace.
    ...(config.mode === "hosted"
      ? {
          create: async (name: string) => {
            const user = await store.user(userId);
            if (!user) throw new RegistryError(404, "Your account no longer exists.");
            return createWorkspace(store, config, user, name);
          },
        }
      : {}),
    switch: (workspaceId: string) => store.switchWorkspace(userId, workspaceId),
  });

  const protectedMcp = requireMcpAuth(
    auth,
    async (request, claims) => {
      // The token names the person; they manage their active workspace, as in the console, and switch_workspace moves it.
      const member = claims.sub ? await store.membership(claims.sub) : undefined;
      if (!member)
        return Response.json(
          { error: "You are not a member of any app-mcp workspace. Ask a workspace admin to invite your email." },
          { status: 403 },
        );
      return mcp.fetch(request, {
        authInfo: {
          token: "",
          clientId: String(claims.azp ?? claims.client_id ?? ""),
          scopes: String(claims.scope ?? "")
            .split(" ")
            .filter(Boolean),
          extra: { member, workspaces: workspaceAccess(member.userId) },
        },
      });
    },
    { resource, jwksUrl: jwks },
  );
  app.all("/mcp", (c) => protectedMcp(c.req.raw));

  // The web console: the management views in a page, calling the same MCP with the session cookie.
  // better-auth's cookies are SameSite=Lax; the origin check also stops cross-site POSTs from same-site hosts.
  app.get("/", (c) => c.redirect("/manage"));
  app.get("/manage", async (c) => ((await session(c.req.raw)) ? c.html(assets.pages.manage) : c.redirect("/sign-in")));
  const origin = new URL(config.baseURL).origin;
  app.all("/manage/mcp", async (c) => {
    if (c.req.method !== "GET" && c.req.header("origin") !== origin) return c.json({ error: "Cross-origin request" }, 403);
    const signedIn = await session(c.req.raw);
    if (!signedIn) return c.json({ error: "Sign in at /sign-in" }, 401);
    const member = await resolveMembership(store, config, signedIn.user);
    if (!member)
      return c.json({ error: "You are not a member of any app-mcp workspace. Ask a workspace admin to invite your email." }, 403);
    const workspaces = workspaceAccess(member.userId);
    return mcp.fetch(c.req.raw, { authInfo: { token: "", clientId: "app-mcp-web", scopes: [], extra: { member, workspaces } } });
  });

  // The person's workspaces, for the console's picker, and switching the active one.
  app.get("/workspaces", async (c) => {
    const signedIn = await session(c.req.raw);
    if (!signedIn) return c.json({ error: "Sign in first." }, 401);
    await resolveMembership(store, config, signedIn.user);
    return c.json({ workspaces: await store.listWorkspaces(signedIn.user.id) });
  });
  app.post("/workspaces/active", async (c) => {
    if (c.req.header("origin") !== origin) return c.json({ error: "Cross-origin request" }, 403);
    const signedIn = await session(c.req.raw);
    if (!signedIn) return c.json({ error: "Sign in first." }, 401);
    const body = z.object({ workspace: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Pick a workspace." }, 400);
    try {
      await store.switchWorkspace(signedIn.user.id, body.data.workspace);
      return c.json({ workspaces: await store.listWorkspaces(signedIn.user.id) });
    } catch (error) {
      if (error instanceof RegistryError) return c.json({ error: error.message }, error.status as 404);
      throw error;
    }
  });

  return auth;
}
