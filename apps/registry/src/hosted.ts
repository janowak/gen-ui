import { DEFAULT_ENVIRONMENT } from "@genui/format";
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
type Hosted = { workspace: { id: string; name: string }; environment: string; dataTools: boolean };
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
    snapshot(environment) {
      const catalog = store.catalog(workspaceId, environment);
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
 * One environment's end-user MCP: genui's forms, charts, recipes and components. Recipes with
 * `validate` are checked by their webhook before the values reach the model.
 */
export async function createHostedMcp(store: Store, { workspace, environment, dataTools }: Hosted, bundle?: BundleLookup, options: RegistryAppOptions = {}): Promise<McpServer> {
  const lookup = bundle ?? ((hash: string) => store.bundle(workspace.id, hash));
  const name = environment === DEFAULT_ENVIRONMENT ? workspace.name : `${workspace.name} (${environment})`;
  const server = new McpServer({ name, version: "0.1.0" });
  await mountGenUI(server, {
    registry: storeCatalog(store, workspace.id, lookup),
    environment,
    dataTools,
    validate: (recipe, values, viewId) =>
      validateWithWebhook({ recipe, values, viewId, workspaceId: workspace.id, secret: store.webhookSecret(workspace.id), allowPrivate: options.allowPrivateWebhooks }),
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
 * End-user MCP at /w/<workspace>/mcp (prod) and /w/<workspace>/<environment>/mcp. The URL alone picks
 * the environment, so what a connector serves never depends on who switched what.
 * - With a server token: upstream for the company's own MCP server (@genui/sdk), data tools on.
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
      allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
      exposeHeaders: ["mcp-session-id"],
    }),
  );

  // The resolved workspace travels in authInfo.extra, as in the management MCP; it is never read from headers.
  const mcp = createMcpHandler((ctx) => {
    const hosted = ctx.authInfo?.extra as Hosted;
    return createHostedMcp(store, hosted, (hash) => bundles(hosted.workspace.id, hash), options);
  });

  function resolve(c: Context, workspaceId: string, environment: string): Hosted | Response {
    const header = c.req.header("authorization");
    let hosted: Hosted;
    if (header) {
      const caller = store.resolveToken(header.replace(/^Bearer\s+/i, ""));
      if (!caller) return c.json({ error: "Invalid token" }, 401);
      const workspace = caller.workspaceId === workspaceId ? store.workspace(workspaceId) : undefined;
      if (!workspace || !ALLOWED.server.includes(caller.scope)) return c.json({ error: "This token can't use this workspace's genui MCP." }, 403);
      hosted = { workspace, environment, dataTools: true };
    } else {
      const workspace = store.hostedWorkspace(workspaceId);
      if (!workspace) return c.json({ error: "No hosted genui MCP at this address." }, 404);
      hosted = { workspace, environment, dataTools: false };
    }
    if (!store.hasEnvironment(workspaceId, environment)) return c.json({ error: `No environment "${environment}" in this workspace.` }, 404);
    return hosted;
  }

  const serve = (c: Context) => {
    const hosted = resolve(c, String(c.req.param("workspace")), c.req.param("environment") ?? DEFAULT_ENVIRONMENT);
    if (hosted instanceof Response) return hosted;
    return mcp.fetch(c.req.raw, { authInfo: { token: "", clientId: "", scopes: [], extra: hosted } });
  };
  app.all("/w/:workspace/mcp", serve);
  app.all("/w/:workspace/:environment/mcp", serve);

  // The environment's revision, next to its MCP: the SDK re-lists genui's tools only when it changed.
  const revision = (c: Context) => {
    const environment = c.req.param("environment") ?? DEFAULT_ENVIRONMENT;
    const hosted = resolve(c, String(c.req.param("workspace")), environment);
    if (hosted instanceof Response) return hosted;
    const current = store.environment(hosted.workspace.id, environment)!.revision;
    const etag = `"${current}"`;
    c.header("etag", etag);
    c.header("cache-control", "no-store");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.json({ revision: current });
  };
  app.get("/w/:workspace/revision", revision);
  app.get("/w/:workspace/:environment/revision", revision);
}
