import type { AppMcpClient } from "./client.js";

/**
 * Your server's refresh endpoint: app-mcp calls it after every change to what your environment serves
 * (a publish, a theme, instructions or workflow save), so your server re-lists app-mcp's tools now instead of at its
 * next check. Register its URL with `app-mcp env set <environment> --refresh-url <url>`.
 *
 * A fetch-style handler (`(request: Request) => Response`) for Hono, Next.js, Bun, Deno or Workers:
 *
 *     app.post("/app-mcp/refresh", (c) => refreshHandler(appMcp)(c.req.raw));
 *
 * It answers 202 at once and refreshes in the background. The body only names a revision, and an
 * up-to-date client ignores it, so the endpoint needs no secret. With Express, call
 * `appMcp.refresh(req.body?.revision)` and answer 202 yourself.
 */
export function refreshHandler(appMcp: AppMcpClient): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405, headers: { allow: "POST" } });
    const body = (await request.json().catch(() => ({}))) as { revision?: unknown };
    void appMcp.refresh(typeof body.revision === "number" ? body.revision : undefined);
    return Response.json({ revision: appMcp.revision() ?? null }, { status: 202 });
  };
}
