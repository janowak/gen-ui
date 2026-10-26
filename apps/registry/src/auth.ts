import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { genericOAuth, jwt } from "better-auth/plugins";
import type { Store } from "./store.js";

/** Claims the access token carries; the role is re-read from the database on every MCP request. */
export const WORKSPACE_CLAIM = "genui/workspace";

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

export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig {
  const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
  const emails = (list?: string) => (list ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const secret = env.GENUI_AUTH_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!secret) console.warn("[genui] GENUI_AUTH_SECRET is not set; using a random secret (sessions reset on restart).");
  return {
    baseURL: (env.GENUI_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4000}`).replace(/\/$/, ""),
    secret: secret ?? randomBytes(32).toString("hex"),
    mode: env.GENUI_MODE === "hosted" ? "hosted" : "self-hosted",
    adminEmails: emails(env.GENUI_ADMIN_EMAILS),
    allowedEmails: emails(env.GENUI_ALLOWED_EMAILS),
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    oidc:
      env.GENUI_OIDC_ISSUER && env.GENUI_OIDC_CLIENT_ID && env.GENUI_OIDC_CLIENT_SECRET
        ? { name: env.GENUI_OIDC_NAME ?? "SSO", issuer: env.GENUI_OIDC_ISSUER.replace(/\/$/, ""), clientId: env.GENUI_OIDC_CLIENT_ID, clientSecret: env.GENUI_OIDC_CLIENT_SECRET }
        : undefined,
    password: env.GENUI_PASSWORD_LOGIN === "true",
    dynamicRegistration: env.GENUI_ALLOW_DCR === "true",
  };
}

/**
 * better-auth as the OAuth 2.1 authorization server for the registry MCP:
 * MCP clients (Claude, ChatGPT…) identify via Client ID Metadata Documents, people sign in
 * with GitHub / Google / the company IdP, and access tokens are JWTs bound to `${baseURL}/mcp`.
 */
export async function createAuth(db: DatabaseSync, store: Store, config: AuthConfig) {
  const options = authOptions(db, store, config);
  // Migrate before starting better-auth, so it never sees (and warns about) a missing schema.
  await (await getMigrations(options)).runMigrations();
  return betterAuth(options);
}

function authOptions(db: DatabaseSync, store: Store, config: AuthConfig) {
  return {
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    database: db,
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
        customAccessTokenClaims: ({ user }) => {
          if (!user) return {};
          const membership = store.resolveMembership(
            { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerified), name: user.name },
            { mode: config.mode, adminEmails: config.adminEmails, allowedEmails: config.allowedEmails },
          );
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

export type Auth = Awaited<ReturnType<typeof createAuth>>;

/** What the sign-in page offers. */
export function signInOptions(config: AuthConfig) {
  return {
    github: Boolean(config.github),
    google: Boolean(config.google),
    sso: config.oidc ? { providerId: SSO_PROVIDER_ID, name: config.oidc.name } : null,
    password: config.password,
  };
}
