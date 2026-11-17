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

type Code = { token: string; challenge: string; expires: number };

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
 * `app-mcp login`: the CLI opens /cli in the browser, the signed-in person clicks Allow, and the CLI gets
 * a token for that person without anyone copying a secret. It reaches every workspace they're in, with
 * their role in each; the CLI names the workspace on each request.
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
  app.get("/cli", async (c) => {
    const url = new URL(c.req.url);
    return (await session(c.req.raw)) ? c.html(page) : c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
  });

  // What the page shows before the person decides.
  app.get("/cli/workspace", async (c) => {
    const signedIn = await session(c.req.raw);
    if (!signedIn) return c.json({ error: "Sign in first." }, 401);
    const membership = await resolveMembership(store, config, signedIn.user);
    // Signed in but in no workspace: the sign-up gate (APP_MCP_ALLOWED_EMAILS) kept them out, or their
    // workspace belongs to another account. Saying "sign in" here sent people round in circles.
    if (!membership)
      return c.json(
        {
          error: `${signedIn.user.email} isn't in an app-mcp workspace. Sign in with the account that has one, or ask its admin to invite this email.`,
        },
        403,
      );
    return c.json({ email: signedIn.user.email });
  });

  // The person clicked Allow. Same-origin only, like the web console: the session cookie alone isn't enough.
  app.post("/cli/approve", async (c) => {
    if (c.req.header("origin") !== origin) return c.json({ error: "Cross-origin request" }, 403);
    const signedIn = await session(c.req.raw);
    if (!signedIn) return c.json({ error: "Sign in first." }, 401);
    const body = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "This sign-in link is incomplete. Run app-mcp login again." }, 400);
    const { port, state, challenge, device } = body.data;
    if (!(await resolveMembership(store, config, signedIn.user)))
      return c.json({ error: `${signedIn.user.email} isn't in an app-mcp workspace.` }, 403);
    const token = await store.addPersonToken(signedIn.user.id, `CLI on ${device}`);
    const code = await sign({ token, challenge, expires: Date.now() + CODE_SECONDS * 1000 });
    const callback = new URL(`http://127.0.0.1:${port}/callback`);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return c.json({ url: callback.href });
  });

  // The CLI trades the code for the token's secret. No session: the code and the verifier are the proof.
  app.post("/cli/token", async (c) => {
    const body = TokenBody.safeParse(await c.req.json().catch(() => ({})));
    const code = body.success ? await verify(body.data.code) : undefined;
    if (!body.success || !code || code.expires < Date.now())
      return c.json({ error: "This sign-in expired. Run app-mcp login again." }, 400);
    const challenge = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(body.data.verifier)));
    if (challenge !== code.challenge) return c.json({ error: "This sign-in was started by another app-mcp login." }, 400);
    try {
      const token = await store.revealPersonToken(code.token);
      const { userId } = (await store.resolvePersonToken(token))!;
      const workspaces = await store.listWorkspaces(userId);
      return c.json({
        token,
        email: (await store.user(userId))?.email,
        // The active one first: the CLI's default until `app-mcp use` picks another.
        workspaces: workspaces.map(({ id, name, slug, role }) => ({
          id,
          name,
          slug,
          role,
          mcp: `${config.baseURL}${endUserPath(slug, DEFAULT_ENVIRONMENT)}`,
        })),
      });
    } catch (error) {
      if (error instanceof RegistryError) return c.json({ error: "This sign-in was already used. Run app-mcp login again." }, 400);
      throw error;
    }
  });
}
