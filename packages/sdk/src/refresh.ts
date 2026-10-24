import type { GenUIClient } from "./client.js";

/**
 * Your server's refresh endpoint: genui calls it after every change to what your environment serves
 * (a publish, a theme or recipe save), so your server re-lists genui's tools now instead of at its
 * next check. Register its URL with `genui env set <environment> --refresh-url <url>`.
 *
 * A fetch-style handler (`(request: Request) => Response`) for Hono, Next.js, Bun, Deno or Workers:
 *
 *     app.post("/genui/refresh", (c) => refreshHandler(genui)(c.req.raw));
 *
 * It answers 202 at once and refreshes in the background. The body only names a revision, and an
 * up-to-date client ignores it, so the endpoint needs no secret. With Express, call
 * `genui.refresh(req.body?.revision)` and answer 202 yourself.
 */
export function refreshHandler(genui: GenUIClient): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405, headers: { allow: "POST" } });
    const body = (await request.json().catch(() => ({}))) as { revision?: unknown };
    void genui.refresh(typeof body.revision === "number" ? body.revision : undefined);
    return Response.json({ revision: genui.revision() ?? null }, { status: 202 });
  };
}
