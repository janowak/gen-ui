import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireMcpAuth } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, signInOptions, WORKSPACE_CLAIM, type Auth, type AuthConfig } from "./auth.js";
import { createRegistryMcp } from "./mcp.js";
import type { Membership, Store } from "./store.js";

const page = (name: "sign-in" | "consent") => readFileSync(new URL(`../dist-web/${name}.html`, import.meta.url), "utf8");

/**
 * Management in chat: better-auth (OAuth for MCP clients, sign-in, consent) plus the
 * registry MCP at /mcp. Tokens are bound to `${baseURL}/mcp`; the person's role is read
 * from the database on every request, so role changes apply immediately.
 */
export async function enableManagement(app: Hono, db: DatabaseSync, store: Store, config: AuthConfig): Promise<Auth> {
  const auth = await createAuth(db, store, config);
  const resource = `${config.baseURL}/mcp`;

  // Browser-based MCP clients (MCP Inspector, the playground) call these cross-origin. They use bearer
  // tokens / PKCE, never cookies, so CORS stays credential-less. Session endpoints get no CORS.
  const publicCors = cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id", "x-genui-channel"],
    exposeHeaders: ["www-authenticate", "mcp-session-id"],
  });
  for (const path of ["/mcp", "/.well-known/*", "/api/auth/oauth2/token", "/api/auth/oauth2/register", "/api/auth/jwks"]) app.use(path, publicCors);

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

  // Sign-in and consent pages (better-auth's client resumes the OAuth flow from them).
  const signIn = page("sign-in");
  const consent = page("consent");
  app.get("/sign-in", (c) => c.html(signIn));
  app.get("/consent", (c) => c.html(consent));
  app.get("/auth/options", (c) => c.json(signInOptions(config)));

  // The verified membership travels in authInfo.extra; the handler never reads it from headers.
  const mcp = createMcpHandler((ctx) => createRegistryMcp(store, (ctx.authInfo?.extra as { member: Membership }).member));

  const protectedMcp = requireMcpAuth(
    auth,
    async (request, claims) => {
      const member = claims.sub ? store.membership(claims.sub, claims[WORKSPACE_CLAIM] as string | undefined) : undefined;
      if (!member) return Response.json({ error: "You are not a member of any genui workspace." }, { status: 403 });
      return mcp.fetch(request, {
        authInfo: { token: "", clientId: String(claims.azp ?? claims.client_id ?? ""), scopes: String(claims.scope ?? "").split(" ").filter(Boolean), extra: { member } },
      });
    },
    { resource },
  );
  app.all("/mcp", (c) => protectedMcp(c.req.raw));

  return auth;
}
