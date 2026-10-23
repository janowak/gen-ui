import { Channel } from "@genui/format";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { ALLOWED } from "./api.js";
import type { RegistryAppOptions } from "./app.js";
import { mountGenUI, type CatalogSource } from "./runtime.js";
import type { Store } from "./store.js";
import { validateWithWebhook } from "./webhook.js";

/**
 * Who the end-user MCP serves. Public: anyone with the URL of a workspace that turned hosting on,
 * with no data tools. Upstream: a company's own MCP server, forwarding genui's tools through
 * @genui/sdk with a server token; views call the company's data tools on that server.
 */
type Hosted = { workspace: { id: string; name: string }; channel: Channel; dataTools: boolean };
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

/** The workspace's catalog and bundles, read from the registry's own database. */
export function storeCatalog(store: Store, workspaceId: string, bundle: BundleLookup): CatalogSource {
  return {
    snapshot(channel) {
      const catalog = store.catalog(workspaceId, channel);
      const bundles: Record<string, string> = {};
      for (const { hash } of catalog.components) {
        const html = bundle(hash);
        if (html !== undefined) bundles[hash] = html;
      }
      return { catalog, bundles };
    },
  };
}

/**
 * The workspace's end-user MCP: genui's forms, charts, recipes and components. Recipes with
 * `validate` are checked by their webhook before the values reach the model.
 */
export async function createHostedMcp(store: Store, { workspace, channel, dataTools }: Hosted, bundle?: BundleLookup, options: RegistryAppOptions = {}): Promise<McpServer> {
  const lookup = bundle ?? ((hash: string) => store.bundle(workspace.id, hash));
  const server = new McpServer({ name: workspace.name, version: "0.1.0" });
  await mountGenUI(server, {
    registry: storeCatalog(store, workspace.id, lookup),
    channel,
    dataTools,
    validate: (recipe, values) =>
      validateWithWebhook({ recipe, values, workspaceId: workspace.id, secret: store.webhookSecret(workspace.id), allowPrivate: options.allowPrivateWebhooks }),
  });

  // Earlier versions of components, for old messages the host renders again. Bundles are immutable and kept.
  server.registerResource(
    "genui component version",
    new ResourceTemplate("ui://genui/c/{name}/{hash}", { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE },
    async (uri, { hash }) => {
      const html = lookup(String(hash));
      if (html === undefined) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    },
  );
  return server;
}

/**
 * End-user MCP at /w/<workspace>/mcp (stable) and /w/<workspace>/beta/mcp.
 * - With a server token: upstream for the company's own MCP server (@genui/sdk), data tools on.
 *   The channel comes from x-genui-channel, so one URL serves both.
 * - Without: public, for workspaces that turned hosting on. Anyone with the URL can render the
 *   workspace's forms, charts and components; form values go back to the conversation.
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

  function resolve(c: Context, workspaceId: string, pathChannel: Channel): Hosted | Response {
    const header = c.req.header("authorization");
    if (header) {
      const caller = store.resolveToken(header.replace(/^Bearer\s+/i, ""));
      if (!caller) return c.json({ error: "Invalid token" }, 401);
      const workspace = caller.workspaceId === workspaceId ? store.workspace(workspaceId) : undefined;
      if (!workspace || !ALLOWED.server.includes(caller.scope)) return c.json({ error: "This token can't use this workspace's genui MCP." }, 403);
      return { workspace, channel: Channel.catch(pathChannel).parse(c.req.header("x-genui-channel")), dataTools: true };
    }
    const workspace = store.hostedWorkspace(workspaceId);
    if (!workspace) return c.json({ error: "No hosted genui MCP at this address." }, 404);
    return { workspace, channel: pathChannel, dataTools: false };
  }

  const serve = (channel: Channel) => (c: Context) => {
    const hosted = resolve(c, String(c.req.param("workspace")), channel);
    if (hosted instanceof Response) return hosted;
    return mcp.fetch(c.req.raw, { authInfo: { token: "", clientId: "", scopes: [], extra: hosted } });
  };
  app.all("/w/:workspace/mcp", serve("stable"));
  app.all("/w/:workspace/beta/mcp", serve("beta"));
}
