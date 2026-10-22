import type { Channel } from "@genui/format";
import { mountGenUI, type RegistryClient, type Snapshot } from "@genui/sdk";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { RegistryAppOptions } from "./app.js";
import type { Store } from "./store.js";
import { validateWithWebhook } from "./webhook.js";

type Hosted = { workspace: { id: string; name: string }; channel: Channel };
type BundleLookup = (hash: string) => string | undefined;

/**
 * Bundles never change for a hash, so hosted servers built per request share them from memory.
 * Keys include the workspace (no cross-tenant sharing by hash); least recently used go first.
 */
function bundleCache(store: Store, maxBytes = 64 * 1024 * 1024) {
  const entries = new Map<string, string>();
  let bytes = 0;
  return (workspaceId: string, hash: string): string | undefined => {
    const key = `${workspaceId}:${hash}`;
    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    }
    const html = store.bundle(workspaceId, hash);
    if (html === undefined) return undefined;
    entries.set(key, html);
    bytes += html.length;
    for (const [oldest, value] of entries) {
      if (bytes <= maxBytes) break;
      entries.delete(oldest);
      bytes -= value.length;
    }
    return html;
  };
}

/** A RegistryClient over the registry's own database: always current, so there is nothing to poll or watch. */
export function storeRegistry(store: Store, workspaceId: string, bundle: BundleLookup = (hash) => store.bundle(workspaceId, hash)): RegistryClient {
  const snapshots = new Map<Channel, Snapshot>();
  return {
    ready: async () => {},
    snapshot(channel) {
      let snapshot = snapshots.get(channel);
      if (!snapshot) {
        const catalog = store.catalog(workspaceId, channel);
        const bundles: Record<string, string> = {};
        for (const { hash } of catalog.components) {
          const html = bundle(hash);
          if (html !== undefined) bundles[hash] = html;
        }
        snapshot = { catalog, bundles };
        snapshots.set(channel, snapshot);
      }
      return snapshot;
    },
    refresh: async () => snapshots.clear(),
    onChange: () => () => {},
    close: () => {},
  };
}

/**
 * The workspace's end-user MCP: the server a company runs with @genui/sdk, without their data
 * tools. Recipes with `validate` are checked by their webhook before the values reach the model.
 */
export async function createHostedMcp(store: Store, { workspace, channel }: Hosted, bundle?: BundleLookup, options: RegistryAppOptions = {}): Promise<McpServer> {
  const server = new McpServer({ name: workspace.name, version: "0.1.0" });
  await mountGenUI(server, {
    registry: storeRegistry(store, workspace.id, bundle),
    channel,
    dataTools: false,
    validate: (recipe, values) =>
      validateWithWebhook({ recipe, values, workspaceId: workspace.id, secret: store.webhookSecret(workspace.id), allowPrivate: options.allowPrivateWebhooks }),
  });
  return server;
}

/**
 * Hosted end-user MCP at /w/<workspace>/mcp (stable) and /w/<workspace>/beta/mcp, for workspaces
 * that turned hosting on. Public: anyone with the URL can render the workspace's forms, charts and
 * components. There are no data tools, so form values go back to the conversation.
 */
export function enableHosting(app: Hono, store: Store, options: RegistryAppOptions = {}): void {
  const bundles = bundleCache(store);

  // Browser-based MCP clients (MCP Inspector, the playground) call it cross-origin. No cookies, so no credentials.
  app.use(
    "/w/*",
    cors({
      origin: "*",
      allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id", "x-genui-channel"],
      exposeHeaders: ["mcp-session-id"],
    }),
  );

  // The resolved workspace travels in authInfo.extra, as in the management MCP; it is never read from headers.
  const mcp = createMcpHandler((ctx) => {
    const hosted = ctx.authInfo?.extra as Hosted;
    return createHostedMcp(store, hosted, (hash) => bundles(hosted.workspace.id, hash), options);
  });

  const serve = (channel: Channel) => (c: Context) => {
    const workspace = store.hostedWorkspace(String(c.req.param("workspace")));
    if (!workspace) return c.json({ error: "No hosted genui MCP at this address." }, 404);
    return mcp.fetch(c.req.raw, { authInfo: { token: "", clientId: "", scopes: [], extra: { workspace, channel } } });
  };
  app.all("/w/:workspace/mcp", serve("stable"));
  app.all("/w/:workspace/beta/mcp", serve("beta"));
}
