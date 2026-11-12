import type { Hono } from "hono";
import { z } from "zod";
import { endUserPath } from "./api.js";
import { resolveMembership, type AuthConfig } from "./auth.js";
import { DEFAULT_ENVIRONMENT } from "@app-mcp/format";
import { RegistryError, type Store } from "./store.js";

/** How long the CLI has to exchange the code it was sent after the person clicked Allow. */
const CODE_SECONDS = 120;

const ApproveBody = z.object({
  /** The CLI listens on this loopback port for the code. */
  port: z.number().int().min(1024).max(65535),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** base64url SHA-256 of the CLI's verifier (PKCE S256). */
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  device: z.string().trim().min(1).max(60),
});
const TokenBody = z.object({ code: z.string().min(1).max(2000), verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });

type Code = { token: string; workspace: string; challenge: string; expires: number };

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** Where a signed-out person is sent back to after signing in: only the CLI's own page. */
export const isCliPath = (path: string | undefined | null): path is string => Boolean(path?.startsWith("/cli?"));

/**
 * `app-mcp login`: the CLI opens /cli in the browser, the signed-in admin clicks Allow, and the CLI gets
 * an admin token for the workspace without anyone copying a secret.
 *
 * The browser only ever carries a short-lived code, sent to the CLI's loopback port. The code is signed
 * with the registry's secret (no table for it) and names a token that has no secret yet. The CLI trades
 * it, with the verifier only it knows, for the secret. A token is revealed once, so a code works once.
 */
export function enableCliLogin(
  app: Hono,
  store: Store,
  config: AuthConfig,
  page: string,
  session: (request: Request) => Promise<{ user: Parameters<typeof resolveMembership>[2] } | null>,
): void {
  const key = crypto.subtle.importKey("raw", encoder.encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  async function sign(code: Code): Promise<string> {
    const payload = base64url(encoder.encode(JSON.stringify(code)));
    return `${payload}.${base64url(await crypto.subtle.sign("HMAC", await key, encoder.encode(payload)))}`;
  }

  async function verify(text: string): Promise<Code | undefined> {
    const [payload, signature] = text.split(".");
    if (!payload || !signature) return undefined;
    try {
      if (!(await crypto.subtle.verify("HMAC", await key, fromBase64url(signature), encoder.encode(payload)))) return undefined;
      return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Code;
    } catch {
      return undefined;
    }
  }

  const origin = new URL(config.baseURL).origin;
  const member = async (request: Request) => {
    const signedIn = await session(request);
    return signedIn ? resolveMembership(store, config, signedIn.user) : undefined;
  };

  app.get("/cli", async (c) => {
    const url = new URL(c.req.url);
    return (await session(c.req.raw)) ? c.html(page) : c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
  });

  // What the page shows before the person decides.
  app.get("/cli/workspace", async (c) => {
    const membership = await member(c.req.raw);
    if (!membership) return c.json({ error: "Sign in at /sign-in" }, 401);
    const workspace = await store.workspace(membership.workspaceId);
    return c.json({ workspace: workspace?.name ?? membership.workspaceId, admin: membership.role === "admin" });
  });

  // The person clicked Allow. Same-origin only, like the web console: the session cookie alone isn't enough.
  app.post("/cli/approve", async (c) => {
    if (c.req.header("origin") !== origin) return c.json({ error: "Cross-origin request" }, 403);
    const membership = await member(c.req.raw);
    if (!membership) return c.json({ error: "Sign in at /sign-in" }, 401);
    if (membership.role !== "admin") return c.json({ error: "Only workspace admins can sign the CLI in. Ask an admin for a publish token." }, 403);
    const body = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "This sign-in link is incomplete. Run app-mcp login again." }, 400);
    const { port, state, challenge, device } = body.data;
    const token = await store.addToken(membership.workspaceId, "admin", `CLI on ${device}`);
    const code = await sign({ token, workspace: membership.workspaceId, challenge, expires: Date.now() + CODE_SECONDS * 1000 });
    const callback = new URL(`http://127.0.0.1:${port}/callback`);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return c.json({ url: callback.href });
  });

  // The CLI trades the code for the token's secret. No session: the code and the verifier are the proof.
  app.post("/cli/token", async (c) => {
    const body = TokenBody.safeParse(await c.req.json().catch(() => ({})));
    const code = body.success ? await verify(body.data.code) : undefined;
    if (!body.success || !code || code.expires < Date.now()) return c.json({ error: "This sign-in expired. Run app-mcp login again." }, 400);
    const challenge = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(body.data.verifier)));
    if (challenge !== code.challenge) return c.json({ error: "This sign-in was started by another app-mcp login." }, 400);
    try {
      const token = await store.revealToken(code.workspace, code.token);
      const workspace = await store.workspace(code.workspace);
      return c.json({
        token,
        workspace: { id: code.workspace, name: workspace?.name ?? code.workspace },
        mcp: `${config.baseURL}${endUserPath(code.workspace, DEFAULT_ENVIRONMENT)}`,
      });
    } catch (error) {
      if (error instanceof RegistryError) return c.json({ error: "This sign-in was already used. Run app-mcp login again." }, 400);
      throw error;
    }
  });
}
