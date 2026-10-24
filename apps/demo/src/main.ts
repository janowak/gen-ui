import { connectGenUI, mountGenUI } from "@genui/sdk";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import cors from "cors";
import type { Request, Response } from "express";
import { registerCompanyTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3001);

// genui's end-user MCP and a server token for it. The URL picks the environment:
// the registry's /w/<workspace>/mcp for prod, /w/<workspace>/<environment>/mcp for the others.
const genui = process.env.GENUI_MCP_URL
  ? connectGenUI({ url: process.env.GENUI_MCP_URL, token: process.env.GENUI_MCP_TOKEN ?? "", refreshSeconds: 10 })
  : undefined;
if (!genui) console.warn("GENUI_MCP_URL is not set: serving the company tools only. Set GENUI_MCP_URL and GENUI_MCP_TOKEN in .env.local for forms and charts.");

async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: "genui-demo", version: "0.1.0" });
  registerCompanyTools(server);
  if (genui) await mountGenUI(server, { genui });
  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.use(cors({ exposedHeaders: ["mcp-session-id"] }));

// Stateless: a fresh server per request.
app.all("/mcp", async (req: Request, res: Response) => {
  const server = await createServer();
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

// genui calls this after every publish, theme or recipe change: genui env set <env> --refresh-url http://<this server>/genui/refresh
app.post("/genui/refresh", (req: Request, res: Response) => {
  const revision: unknown = req.body?.revision;
  void genui?.refresh(typeof revision === "number" ? revision : undefined);
  res.status(202).json({ revision: genui?.revision() ?? null });
});

app.listen(PORT, () =>
  console.log(`genui demo MCP server on http://localhost:${PORT}/mcp${genui ? ` (genui: ${process.env.GENUI_MCP_URL})` : ""}`),
);
