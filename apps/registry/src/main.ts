import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { serve } from "@hono/node-server";
import { createRegistryApp } from "./app.js";
import { loadAssets } from "./assets-node.js";
import { authConfigFromEnv } from "./auth.js";
import { openDatabase } from "./db-node.js";
import { enableManagement } from "./management.js";

// The registry on Node: local development and the Docker image (self-hosting). worker.ts runs it on Cloudflare.
const PORT = Number(process.env.PORT ?? 4000);
const DATABASE = process.env.GENUI_DB ?? "genui-registry.sqlite";

const db = openDatabase(DATABASE);
const assets = await loadAssets();
const config = authConfigFromEnv(process.env);
const { app, store } = createRegistryApp(db, { assets, allowPrivateWebhooks: process.env.GENUI_ALLOW_PRIVATE_WEBHOOKS === "1", baseURL: config.baseURL });

// Self-host bootstrap: first start creates the workspace and prints an admin token once.
// Hosted mode has none: everyone gets a personal workspace at first sign-in.
if (config.mode === "self-hosted" && (await store.countWorkspaces()) === 0) {
  const workspace = await store.createWorkspace(process.env.GENUI_WORKSPACE ?? "default");
  const token = await store.createToken(workspace, "admin", "bootstrap");
  console.log(
    `Created workspace. Admin token (shown once, store it now):\n  ${token}\n` +
      `End-user MCP for @genui/sdk (with a server token: genui token server <name>):\n  ${config.baseURL}/w/${workspace}/mcp\n`,
  );
}

// Management in chat: OAuth for MCP clients + the registry MCP at /mcp.
enableManagement(app, db, store, config, { assets, fetchClientMetadataResource });

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(
    `genui registry on ${config.baseURL} (db: ${DATABASE})\n  MCP for Claude / ChatGPT: ${config.baseURL}/mcp\n` +
      `  End-user MCP (public unless an admin turns it off; server token for data tools): ${config.baseURL}/w/<workspace id>/mcp`,
  ),
);
