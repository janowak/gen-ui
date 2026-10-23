import { connectGenUI, mountGenUI, type Channel } from "@genui/sdk";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import cors from "cors";
import type { Request, Response } from "express";
import { registerCompanyTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3001);

// genui's end-user MCP (the registry's /w/<workspace>/mcp) and a server token for it.
const genui = process.env.GENUI_MCP_URL
  ? connectGenUI({ url: process.env.GENUI_MCP_URL, token: process.env.GENUI_MCP_TOKEN ?? "", refreshSeconds: 10 })
  : undefined;
if (!genui) console.warn("GENUI_MCP_URL is not set: serving the company tools only. Set GENUI_MCP_URL and GENUI_MCP_TOKEN in .env.local for forms and charts.");

async function createServer(channel: Channel): Promise<McpServer> {
  const server = new McpServer({ name: "genui-demo", version: "0.1.0" });
  registerCompanyTools(server);
  if (genui) await mountGenUI(server, { genui, channel });
  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.use(cors({ exposedHeaders: ["mcp-session-id"] }));

// Stateless: a fresh server per request. A real server would pick the channel from the
// authenticated user's groups; the demo reads a header so the playground can switch.
app.all("/mcp", async (req: Request, res: Response) => {
  const channel: Channel = req.header("x-genui-channel") === "beta" ? "beta" : "stable";
  const server = await createServer(channel);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.listen(PORT, () =>
  console.log(`genui demo MCP server on http://localhost:${PORT}/mcp${genui ? ` (genui: ${process.env.GENUI_MCP_URL})` : ""}`),
);
