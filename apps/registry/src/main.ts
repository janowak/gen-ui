import { serve } from "@hono/node-server";
import { createRegistryApp, openDatabase } from "./app.js";
import { authConfigFromEnv } from "./auth.js";
import { enableManagement } from "./management.js";

const PORT = Number(process.env.PORT ?? 4000);
const DATABASE = process.env.GENUI_DB ?? "genui-registry.sqlite";

const db = openDatabase(DATABASE);
const { app, store } = createRegistryApp(db, { allowPrivateWebhooks: process.env.GENUI_ALLOW_PRIVATE_WEBHOOKS === "1" });
const config = authConfigFromEnv(process.env);

// Self-host bootstrap: first start creates a workspace and prints an admin token once.
if (store.countWorkspaces() === 0) {
  const workspace = store.createWorkspace(process.env.GENUI_WORKSPACE ?? "default");
  const token = store.createToken(workspace, "admin", "bootstrap");
  console.log(
    `Created workspace. Admin token (shown once, store it now):\n  ${token}\n` +
      `End-user MCP for @genui/sdk (with a server token: genui token server <name>):\n  ${config.baseURL}/w/${workspace}/mcp\n`,
  );
}

// Management in chat: OAuth for MCP clients + the registry MCP at /mcp.
await enableManagement(app, db, store, config);

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(
    `genui registry on ${config.baseURL} (db: ${DATABASE})\n  MCP for Claude / ChatGPT: ${config.baseURL}/mcp\n` +
      `  End-user MCP (public unless an admin turns it off; server token for data tools): ${config.baseURL}/w/<workspace id>/mcp`,
  ),
);
