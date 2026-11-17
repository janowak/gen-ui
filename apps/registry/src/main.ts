import { fileAssetStore } from "./static-assets-node.js";
import { hostViews } from "./views.js";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { serve } from "@hono/node-server";
import { createRegistryApp, HOSTED_QUOTAS } from "./app.js";
import { loadAssets } from "./assets-node.js";
import { authConfigFromEnv } from "./auth.js";
import { openDatabase } from "./db-node.js";
import { enableManagement } from "./management.js";

// The registry on Node: local development and the Docker image (self-hosting). worker.ts runs it on Cloudflare.
const PORT = Number(process.env.PORT ?? 4000);
const DATABASE = process.env.APP_MCP_DB ?? "app-mcp-registry.sqlite";

const db = openDatabase(DATABASE);
const config = authConfigFromEnv(process.env);
const staticHosting = {
  baseURL: process.env.APP_MCP_ASSET_URL ?? `${config.baseURL}/assets/`,
  store: fileAssetStore(process.env.APP_MCP_ASSET_DIR ?? `${DATABASE}.assets`),
};
const assets = await hostViews(await loadAssets(), staticHosting);
const { app, store } = createRegistryApp(db, {
  assets,
  staticHosting,
  allowPrivateWebhooks: process.env.APP_MCP_ALLOW_PRIVATE_WEBHOOKS === "1",
  baseURL: config.baseURL,
  // Self-hosted: no caps. APP_MCP_MODE=hosted (local development of the cloud) gets the cloud's.
  quotas: config.mode === "hosted" ? HOSTED_QUOTAS : undefined,
});

// Self-host bootstrap: first start creates the workspace and prints an admin token once.
// Hosted mode has none: everyone gets a personal workspace at first sign-in.
if (config.mode === "self-hosted" && (await store.countWorkspaces()) === 0) {
  const workspace = await store.createWorkspace(process.env.APP_MCP_WORKSPACE ?? "default");
  const token = await store.createToken(workspace, "admin", "bootstrap");
  console.log(
    `Created workspace. Admin token (shown once, store it now):\n  ${token}\n` +
      `End-user MCP for @app-mcp/sdk (with a server token: app-mcp token server <name>):\n  ${config.baseURL}/w/${(await store.workspace(workspace))!.slug}/mcp\n`,
  );
}

// Management in chat: OAuth for MCP clients + the registry MCP at /mcp.
enableManagement(app, db, store, config, { assets, fetchClientMetadataResource });

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(
    `app-mcp registry on ${config.baseURL} (db: ${DATABASE})\n  MCP for Claude / ChatGPT: ${config.baseURL}/mcp\n` +
      `  End-user MCP (public unless an admin turns it off; server token for data tools): ${config.baseURL}/w/<workspace slug>/mcp`,
  ),
);
