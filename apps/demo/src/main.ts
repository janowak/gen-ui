import { createRegistryClient, mountGenUI } from "@genui/sdk";
import type { Channel } from "@genui/format";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import cors from "cors";
import type { Request, Response } from "express";
import { registerCompanyTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3001);

// Optional: pull custom components and the theme from a genui registry.
const registry = process.env.GENUI_REGISTRY_URL
  ? createRegistryClient({
      url: process.env.GENUI_REGISTRY_URL,
      token: process.env.GENUI_REGISTRY_TOKEN ?? "",
      refreshSeconds: 10,
      cacheFile: ".genui-cache.json",
    })
  : undefined;

async function createServer(channel: Channel): Promise<McpServer> {
  const server = new McpServer({ name: "genui-demo", version: "0.1.0" });
  registerCompanyTools(server);
  await mountGenUI(server, {
    registry,
    channel,
    allowTools: {
      sources: ["search_customers", "list_products", "get_revenue"],
      submit: ["create_order", "save_rating"],
    },
    // Without a registry, use a local theme; with one, the registry's workspace theme applies.
    theme: registry
      ? undefined
      : { light: { primary: "#4f46e5", primaryForeground: "#ffffff" }, dark: { primary: "#818cf8", primaryForeground: "#0b0b1a" } },
  });
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
  console.log(`genui demo MCP server on http://localhost:${PORT}/mcp${registry ? ` (registry: ${process.env.GENUI_REGISTRY_URL})` : ""}`),
);
