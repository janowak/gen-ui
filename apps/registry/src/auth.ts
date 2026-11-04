import { randomBytes } from "node:crypto";
import { cimd, type CimdOptions } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { genericOAuth, jwt } from "better-auth/plugins";
import type { Database } from "./db.js";
import type { Store } from "./store.js";

/** Claims the access token carries; the role is re-read from the database on every MCP request. */
export const WORKSPACE_CLAIM = "app-mcp/workspace";

export interface AuthConfig {
  /** Public URL of the registry, e.g. https://registry.example.com. The MCP resource is `${baseURL}/mcp`. */
  baseURL: string;
  secret: string;
  /** hosted: everyone gets a personal workspace. self-hosted: everyone joins the single workspace. */
  mode: "hosted" | "self-hosted";
  /** Emails that become admins (self-hosted). The first person to sign in is always an admin. */
  adminEmails: string[];
  /**
   * Sign-up gate: when set, only these verified emails (and `@domain` entries) get a workspace at first
   * sign-in. Existing members and invited emails always get in. Empty: anyone who can sign in.
   */
  allowedEmails: string[];
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  /** Company identity provider (Okta, Entra, Google Workspace, Keycloak…) via OIDC discovery. */
  oidc?: { name: string; issuer: string; clientId: string; clientSecret: string };
  /** Email + password sign-in. Meant for local development and small self-hosted installs. */
  password: boolean;
  /**
   * Open dynamic client registration (RFC 7591). Off by default: Claude and ChatGPT use Client ID
   * Metadata Documents. Enable for local development or clients that only support DCR.
   */
  dynamicRegistration?: boolean;
}

export const SSO_PROVIDER_ID = "sso";

/**
 * Fetches Client ID Metadata Documents without reaching private networks: `@better-auth/cimd/node` on
 * Node, which pins the checked DNS answer; a plain fetch on Workers, whose egress can't reach them.
 */
export type MetadataFetch = CimdOptions["fetchClientMetadataResource"];

/** Settings from environment variables: `process.env` on Node, the Worker's env (vars and secrets) on Cloudflare. */
export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
  const emails = (list?: string) =>
    (list ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  const secret = env.APP_MCP_AUTH_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!secret) console.warn("[app-mcp] APP_MCP_AUTH_SECRET is not set; using a random secret (sessions reset on restart).");
  return {
    baseURL: (env.APP_MCP_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4000}`).replace(/\/$/, ""),
    secret: secret ?? randomBytes(32).toString("hex"),
    mode: env.APP_MCP_MODE === "hosted" ? "hosted" : "self-hosted",
    adminEmails: emails(env.APP_MCP_ADMIN_EMAILS),
    allowedEmails: emails(env.APP_MCP_ALLOWED_EMAILS),
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    oidc:
      env.APP_MCP_OIDC_ISSUER && env.APP_MCP_OIDC_CLIENT_ID && env.APP_MCP_OIDC_CLIENT_SECRET
        ? {
            name: env.APP_MCP_OIDC_NAME ?? "SSO",
            issuer: env.APP_MCP_OIDC_ISSUER.replace(/\/$/, ""),
            clientId: env.APP_MCP_OIDC_CLIENT_ID,
            clientSecret: env.APP_MCP_OIDC_CLIENT_SECRET,
          }
        : undefined,
    password: env.APP_MCP_PASSWORD_LOGIN === "true",
    dynamicRegistration: env.APP_MCP_ALLOW_DCR === "true",
  };
}

/**
 * better-auth as the OAuth 2.1 authorization server for the registry MCP:
 * MCP clients (Claude, ChatGPT…) identify via Client ID Metadata Documents, people sign in
 * with GitHub / Google / the company IdP, and access tokens are JWTs bound to `${baseURL}/mcp`.
 */
export function createAuth(db: Database, store: Store, config: AuthConfig, fetchClientMetadataResource: MetadataFetch) {
  return betterAuth(authOptions(db, store, config, fetchClientMetadataResource));
}

/**
 * better-auth's settings. Its tables are in `migrations/` like ours (`pnpm auth-schema` regenerates
 * them after a plugin change), so it never migrates at runtime.
 */
export function authOptions(db: Database, store: Store, config: AuthConfig, fetchClientMetadataResource: MetadataFetch) {
  return {
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    // node:sqlite's DatabaseSync or the D1 binding: better-auth has a dialect for each.
    database: db.auth as BetterAuthOptions["database"],
    emailAndPassword: { enabled: config.password },
    socialProviders: {
      ...(config.github ? { github: config.github } : {}),
      ...(config.google ? { google: config.google } : {}),
    },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: `${config.baseURL}/mcp`,
        allowDynamicClientRegistration: Boolean(config.dynamicRegistration),
        allowUnauthenticatedClientRegistration: Boolean(config.dynamicRegistration),
        customAccessTokenClaims: async ({ user }) => {
          if (!user) return {};
          const membership = await resolveMembership(store, config, user);
          return membership ? { [WORKSPACE_CLAIM]: membership.workspaceId } : {};
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      ...(config.oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: SSO_PROVIDER_ID,
                  name: config.oidc.name,
                  discoveryUrl: `${config.oidc.issuer}/.well-known/openid-configuration`,
                  clientId: config.oidc.clientId,
                  clientSecret: config.oidc.clientSecret,
                  scopes: ["openid", "email", "profile"],
                },
              ],
            }),
          ]
        : []),
    ],
  } satisfies BetterAuthOptions;
}

export type Auth = ReturnType<typeof createAuth>;

/** The person's workspace, joined or made at sign-in: by an access token for MCP clients, by the session for the web console. */
export function resolveMembership(
  store: Store,
  config: AuthConfig,
  user: { id: string; email: string; emailVerified?: boolean | null; name?: string | null },
) {
  return store.resolveMembership(
    { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerified), name: user.name ?? undefined },
    { mode: config.mode, adminEmails: config.adminEmails, allowedEmails: config.allowedEmails },
  );
}

/** What the sign-in page offers. */
export function signInOptions(config: AuthConfig) {
  return {
    github: Boolean(config.github),
    google: Boolean(config.google),
    sso: config.oidc ? { providerId: SSO_PROVIDER_ID, name: config.oidc.name } : null,
    password: config.password,
  };
}
