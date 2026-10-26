import { DEFAULT_ENVIRONMENT, serverInstructions } from "@genui/format";
import { mountGenUI, type CatalogSource } from "@genui/runtime";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { ALLOWED } from "./api.js";
import type { RegistryAppOptions } from "./app.js";
import type { Store } from "./store.js";
import { builtInViews } from "./views.js";

/**
 * Who the end-user MCP serves. Public: anyone with the URL of a workspace that didn't make it private,
 * with no data tools. Upstream: a company's own MCP server, forwarding genui's tools through
 * @genui/sdk with a server token; views call the company's data tools on that server.
 */
type Hosted = { workspace: { id: string; name: string }; environment: string; dataTools: boolean; origin: string };
type BundleLookup = (hash: string) => Promise<string | undefined>;

/**
 * Bundles never change for a hash, so hosted servers built per request share them from memory.
 * Keys include the workspace (no cross-tenant sharing by hash); least recently used go first.
 */
function bundleCache(store: Store, maxBytes = 64 * 1024 * 1024) {
  const entries = new Map<string, string>();
  let bytes = 0;
  return async (workspaceId: string, hash: string): Promise<string | undefined> => {
    const key = `${workspaceId}:${hash}`;
    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    }
    const html = await store.bundle(workspaceId, hash);
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
    async snapshot(environment) {
      const catalog = await store.catalog(workspaceId, environment);
      const bundles: Record<string, string> = {};
      await Promise.all(
        catalog.components.map(async ({ hash }) => {
          const html = await bundle(hash);
          if (html !== undefined) bundles[hash] = html;
        }),
      );
      return { catalog, bundles };
    },
  };
}

/** Where the workspace's connector icon is served; the hash in the query lets hosts cache it for good. */
export const iconPath = (workspaceId: string) => `/w/${workspaceId}/icon`;

/**
 * One environment's end-user MCP: genui's forms, charts and components, presented with the workspace's
 * branding. Its instructions carry the workflows without params; those with params are slash commands.
 */
export async function createHostedMcp(store: Store, { workspace, environment, dataTools, origin }: Hosted, options: RegistryAppOptions, bundle?: BundleLookup): Promise<McpServer> {
  const lookup = bundle ?? ((hash: string) => store.bundle(workspace.id, hash));
  const [branding, snapshot] = await Promise.all([store.branding(workspace.id), storeCatalog(store, workspace.id, lookup).snapshot(environment)]);
  const label = environment === DEFAULT_ENVIRONMENT ? "" : ` (${environment})`;
  const instructions = snapshot && serverInstructions(snapshot.catalog.instructions, snapshot.catalog.workflows);
  const server = new McpServer(
    {
      name: `${workspace.name}${label}`,
      title: `${branding.title ?? workspace.name}${label}`,
      version: "0.1.0",
      ...(branding.description ? { description: branding.description } : {}),
      ...(branding.websiteUrl ? { websiteUrl: branding.websiteUrl } : {}),
      ...(branding.icon
        ? { icons: [{ src: `${origin}${iconPath(workspace.id)}?v=${branding.icon.hash}`, mimeType: branding.icon.type, ...(branding.icon.type === "image/svg+xml" ? { sizes: ["any"] } : {}) }] }
        : {}),
    },
    instructions ? { instructions } : {},
  );
  await mountGenUI(server, {
    views: builtInViews(options.assets),
    registry: { snapshot: async () => snapshot, bundle: lookup },
    environment,
    dataTools,
  });
  return server;
}

/**
 * End-user MCP at /w/<workspace>/mcp (prod) and /w/<workspace>/<environment>/mcp. The URL alone picks
 * the environment, so what a connector serves never depends on who switched what.
 * - With a server token: upstream for the company's own MCP server (@genui/sdk), data tools on.
 * - Without: public, unless an admin made the workspace private. Anyone with the URL can render the
 *   workspace's forms, charts and components; form values go back to the conversation.
 */
export function enableHosting(app: Hono, store: Store, options: RegistryAppOptions): void {
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
    return createHostedMcp(store, hosted, options, (hash) => bundles(hosted.workspace.id, hash));
  });

  // Icons and serverInfo carry absolute URLs: the configured public URL, else the request's own origin.
  const origin = (c: Context) => options.baseURL ?? new URL(c.req.url).origin;

  async function resolve(c: Context, workspaceId: string, environment: string): Promise<Hosted | Response> {
    const header = c.req.header("authorization");
    let hosted: Hosted;
    if (header) {
      const caller = await store.resolveToken(header.replace(/^Bearer\s+/i, ""));
      if (!caller) return c.json({ error: "Invalid token" }, 401);
      const workspace = caller.workspaceId === workspaceId ? await store.workspace(workspaceId) : undefined;
      if (!workspace || !ALLOWED.server.includes(caller.scope)) return c.json({ error: "This token can't use this workspace's genui MCP." }, 403);
      hosted = { workspace, environment, dataTools: true, origin: origin(c) };
    } else {
      const workspace = await store.hostedWorkspace(workspaceId);
      if (!workspace) return c.json({ error: "No hosted genui MCP at this address." }, 404);
      hosted = { workspace, environment, dataTools: false, origin: origin(c) };
    }
    if (!(await store.hasEnvironment(workspaceId, environment))) return c.json({ error: `No environment "${environment}" in this workspace.` }, 404);
    return hosted;
  }

  const serve = async (c: Context) => {
    const hosted = await resolve(c, String(c.req.param("workspace")), c.req.param("environment") ?? DEFAULT_ENVIRONMENT);
    if (hosted instanceof Response) return hosted;
    return mcp.fetch(c.req.raw, { authInfo: { token: "", clientId: "", scopes: [], extra: hosted } });
  };
  app.all("/w/:workspace/mcp", serve);
  app.all("/w/:workspace/:environment/mcp", serve);

  // The connector icon hosts show. Public even for private workspaces: hosts fetch it without the server token.
  app.get(iconPath(":workspace"), async (c) => {
    const icon = await store.icon(String(c.req.param("workspace")));
    if (!icon) return c.json({ error: "No icon" }, 404);
    c.header("content-type", icon.type);
    c.header("x-content-type-options", "nosniff");
    // An SVG opened directly runs no scripts and loads nothing.
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    c.header("cache-control", c.req.query("v") === icon.hash ? "public, max-age=31536000, immutable" : "public, max-age=300");
    return c.body(icon.bytes as Uint8Array<ArrayBuffer>);
  });

  // The environment's revision, next to its MCP: the SDK re-lists genui's tools only when it changed.
  const revision = async (c: Context) => {
    const environment = c.req.param("environment") ?? DEFAULT_ENVIRONMENT;
    const hosted = await resolve(c, String(c.req.param("workspace")), environment);
    if (hosted instanceof Response) return hosted;
    const current = (await store.environment(hosted.workspace.id, environment))!.revision;
    const etag = `"${current}"`;
    c.header("etag", etag);
    c.header("cache-control", "no-store");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.json({ revision: current });
  };
  app.get("/w/:workspace/revision", revision);
  app.get("/w/:workspace/:environment/revision", revision);
}
