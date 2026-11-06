import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createEmbeddedSession, createCloudflareText, toServerSentEventsResponse } from "@app-mcp/host/server";
import { sandboxResponse } from "@app-mcp/host/sandbox";

// Local, single-user starter. In your application authenticate each request and build a
// caller-scoped MCP connection; never reuse a privileged token for arbitrary signed-in users.
const app = new Hono();
app.use("/api/*", async (c, next) => {
  if (c.req.header("origin") !== "http://localhost:4190") return c.json({ error: "Forbidden origin" }, 403);
  if (Number(c.req.header("content-length") ?? 0) > 100000) return c.json({ error: "Request too large" }, 413);
  await next();
});
const session = async () =>
  createEmbeddedSession({
    transport: {
      type: "http",
      url: process.env.EMBED_MCP_URL ?? "http://localhost:4100/mcp",
      headers: process.env.EMBED_MCP_TOKEN ? { Authorization: `Bearer ${process.env.EMBED_MCP_TOKEN}` } : undefined,
    },
    modelTools: (process.env.EMBED_MODEL_TOOLS ?? "render_form,render_chart").split(","),
    appTools: (process.env.EMBED_APP_TOOLS ?? "").split(",").filter(Boolean),
  });
app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const mcp = await session();
  async function* respond() {
    try {
      yield* mcp.stream({
        adapter: createCloudflareText("@cf/openai/gpt-oss-120b", {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
          apiKey: process.env.WORKERS_AI_API_TOKEN!,
        }),
        threadId: body.threadId,
        messages: body.messages,
        signal: c.req.raw.signal,
      });
    } finally {
      await mcp.close();
    }
  }
  return toServerSentEventsResponse(respond());
});
app.post("/api/widget", async (c) => {
  const body = await c.req.json();
  const mcp = await session();
  try {
    return c.json(await mcp.callTool(body.name, body.args));
  } finally {
    await mcp.close();
  }
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4191 });
serve({ fetch: (request) => sandboxResponse(request, ["http://localhost:4190"]), hostname: "127.0.0.1", port: 4192 });
