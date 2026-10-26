import { connectGenUI, mountGenUI } from "@genui/sdk";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import cors from "cors";
import type { Request, Response } from "express";
import { registerCompanyTools } from "./tools.js";

// Not PORT: the registry reads that from the same .env files.
const PORT = Number(process.env.GENUI_DEMO_PORT ?? 3001);

// genui's end-user MCP and a server token for it. By default `genui serve` on this machine, which
// takes any token. On the registry, the URL picks the environment: /w/<workspace>/mcp for prod,
// /w/<workspace>/<environment>/mcp for the others.
const genuiUrl = process.env.GENUI_MCP_URL ?? "http://localhost:4100/mcp";
const genui = connectGenUI({ url: genuiUrl, token: process.env.GENUI_MCP_TOKEN ?? "local", refreshSeconds: 10 });
console.log(`genui: ${genuiUrl}${process.env.GENUI_MCP_URL ? "" : " (genui serve; set GENUI_MCP_URL and GENUI_MCP_TOKEN in .env.local for a registry)"}`);

async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: "genui-demo", version: "0.1.0" });
  registerCompanyTools(server);
  await mountGenUI(server, { genui });
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

// genui calls this after every publish, theme, instructions or workflow change: genui env set <env> --refresh-url http://<this server>/genui/refresh
app.post("/genui/refresh", (req: Request, res: Response) => {
  const revision: unknown = req.body?.revision;
  void genui.refresh(typeof revision === "number" ? revision : undefined);
  res.status(202).json({ revision: genui.revision() ?? null });
});

app.listen(PORT, () =>
  console.log(`genui demo MCP server on http://localhost:${PORT}/mcp (genui: ${genuiUrl})`),
);
