import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { serve as listen, type ServerType } from "@hono/node-server";
import { McpServer, WebStandardStreamableHTTPServerTransport, type Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { localCatalog, type LocalCatalog, type LocalCatalogOptions } from "./local.js";
import { mountGenUI, type Mounted } from "./runtime.js";
import { viewBundles, type ViewBundle, type ViewName } from "./views.js";

const require = createRequire(import.meta.url);

/** The built-in form and chart views from @genui/ui. */
export async function loadViews(): Promise<Record<ViewName, ViewBundle>> {
  const view = (name: ViewName) => readFile(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
  const [form, chart] = await Promise.all([view("form"), view("chart")]);
  return viewBundles({ form, chart });
}

export interface LocalMcpOptions {
  catalog: LocalCatalog;
  views: Record<ViewName, ViewBundle>;
  /**
   * Serve as this environment: tool and prompt names end in `_<name>`, so the local connector can
   * sit next to prod's in the same chat. Default: none, so tool names match prod.
   */
  suffix?: string;
  /** Answer requests with any Host header. Off by default, so a web page can't reach it through DNS rebinding. */
  anyHost?: boolean;
}

interface Session {
  server: McpServer;
  mounted: Mounted;
  dataTools: boolean;
  transport?: WebStandardStreamableHTTPServerTransport;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const rpcError = (status: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });

/**
 * A local genui MCP: genui's forms, charts and the catalog's components and workflows, with no registry.
 * Each session gets its own server, mounted again when the catalog changes (`changed()`), which
 * tells the client its lists changed.
 *
 * Who connects decides the mode, as on the registry's end-user MCP: with any bearer token it's
 * upstream for @genui/sdk (data tools on); without one it's a host talking to it directly, which
 * only renders.
 */
export function createLocalMcp(options: LocalMcpOptions) {
  const { catalog, views } = options;
  const environment = options.suffix ?? "prod";
  const sessions = new Map<string, Session>();
  const stdio = new Set<Session>();
  let remounting = Promise.resolve();

  const mount = (server: McpServer, dataTools: boolean) => mountGenUI(server, { views, registry: catalog, environment, dataTools });

  async function open(dataTools: boolean): Promise<Session> {
    const instructions = catalog.instructions();
    const server = new McpServer(
      { name: "genui-local", title: "genui (local)", version: "0.1.0" },
      {
        ...(instructions ? { instructions } : {}),
        // A remount removes and adds every tool: one notification per kind, not one per tool.
        debouncedNotificationMethods: [
          "notifications/tools/list_changed",
          "notifications/resources/list_changed",
          "notifications/prompts/list_changed",
        ],
      },
    );
    return { server, mounted: await mount(server, dataTools), dataTools };
  }

  async function handleMcp(request: Request): Promise<Response> {
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = sessions.get(id);
      if (!session) return rpcError(404, "Session not found. Reconnect.");
      return session.transport!.handleRequest(request);
    }
    if (request.method !== "POST") return rpcError(400, "Missing mcp-session-id. Start with initialize.");

    const session = await open(request.headers.has("authorization"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => void sessions.set(sessionId, session),
      onsessionclosed: (sessionId) => void sessions.delete(sessionId),
    });
    session.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await session.server.connect(transport);
    const response = await transport.handleRequest(request);
    // Not an initialize request: no session started, so nothing keeps this server.
    if (!transport.sessionId) await session.server.close();
    return response;
  }

  return {
    /** HTTP: the MCP at /mcp and its revision at /revision (what @genui/sdk checks). */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!options.anyHost && !LOCAL_HOSTS.has(url.hostname))
        return withCors(
          Response.json({ error: `Host ${url.host} is not allowed; start with --host to serve other names.` }, { status: 403 }),
        );
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/mcp") return withCors(await handleMcp(request));
      if (url.pathname === "/revision" && request.method === "GET") {
        const etag = `"${catalog.revision()}"`;
        if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...CORS, etag } });
        return withCors(Response.json({ revision: catalog.revision() }, { headers: { etag, "cache-control": "no-store" } }));
      }
      return withCors(Response.json({ error: "Not found. The MCP is at /mcp." }, { status: 404 }));
    },
    /** One client over a transport it owns, such as stdio. Only renders: no data tools. */
    async connect(transport: Transport): Promise<void> {
      const session = await open(false);
      stdio.add(session);
      transport.onclose = () => void stdio.delete(session);
      await session.server.connect(transport);
    },
    /** Mounts the catalog again on every session, after a change. */
    changed(): Promise<void> {
      remounting = remounting.then(async () => {
        for (const session of [...sessions.values(), ...stdio]) {
          session.mounted.remove();
          session.mounted = await mount(session.server, session.dataTools);
        }
      });
      return remounting;
    },
    sessions: () => sessions.size + stdio.size,
    async close(): Promise<void> {
      await Promise.all([...sessions.values(), ...stdio].map((session) => session.server.close()));
      sessions.clear();
      stdio.clear();
    },
  };
}

export type LocalMcp = ReturnType<typeof createLocalMcp>;

/**
 * Calls `onChange` (debounced) when a watched path changes. Component directories are watched
 * whole, without node_modules; files through their directory, since builds replace them.
 */
export function watchPaths(
  paths: { dirs: string[]; files: string[] },
  onChange: () => void,
  onError: (message: string) => void,
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };
  const add = (path: string, recursive: boolean, accept: (file: string | null) => boolean) => {
    try {
      const watcher = watch(path, { recursive }, (_event, file) => {
        if (accept(file)) changed();
      });
      watcher.on("error", (error) => onError(`not watching ${path}: ${error.message}`));
      watchers.push(watcher);
    } catch (cause) {
      onError(`not watching ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  for (const dir of paths.dirs) add(resolve(dir), true, (file) => !file || !file.split(/[\\/]/).includes("node_modules"));
  for (const file of paths.files) add(dirname(resolve(file)), false, (name) => !name || name === basename(file));
  return () => {
    clearTimeout(timer);
    watchers.forEach((watcher) => watcher.close());
  };
}

export interface ServeOptions extends LocalCatalogOptions {
  /** HTTP port. Default 4100; 0 picks a free one. */
  port?: number;
  /** HTTP interface. Default 127.0.0.1; anything else also answers other Host names. */
  host?: string;
  /** Serve over stdin/stdout instead of HTTP. */
  stdio?: boolean;
  suffix?: string;
  /** POSTed `{ type: "genui.refresh", environment, revision }` on every change, like the registry's refresh URL. */
  refreshUrl?: string;
  /** Builds component directories that have a build, and rebuilds them on change (@genui/kit's watchBuild). */
  build?: (dir: string, onBuild: (error?: Error) => void) => Promise<{ close(): Promise<void> } | undefined>;
  /** Where lines for the developer go. Default stderr, so stdout stays free for stdio. */
  log?: (line: string) => void;
}

export interface Served {
  /** The MCP's URL, over HTTP. */
  url?: string;
  catalog: LocalCatalog;
  mcp: LocalMcp;
  close(): Promise<void>;
}

/** `genui serve`: builds, loads and watches the local catalog and serves it over HTTP or stdio. */
export async function startServe(options: ServeOptions): Promise<Served> {
  const log = options.log ?? ((line: string) => console.error(line));
  const closers: (() => Promise<void> | void)[] = [];

  for (const dir of options.dirs) {
    const watcher = await options.build?.(dir, (error) => {
      if (error) log(`build failed in ${dir}: ${error.message}`);
    });
    if (watcher) closers.push(() => watcher.close());
  }

  const catalog = await localCatalog(options);
  for (const problem of catalog.problems()) log(`problem: ${problem.message}`);
  const mcp = createLocalMcp({
    catalog,
    views: await loadViews(),
    suffix: options.suffix,
    anyHost: options.host !== undefined && options.host !== "127.0.0.1" && options.host !== "localhost",
  });
  closers.push(() => mcp.close());

  let reloading = Promise.resolve();
  const reload = () => {
    reloading = reloading.then(async () => {
      const { changed, lines } = await catalog.reload();
      for (const line of lines)
        log(
          line.startsWith("instructions") || line.startsWith("workflows") ? `${line}; instructions update when a client reconnects` : line,
        );
      if (!changed) return;
      await mcp.changed();
      if (options.refreshUrl) {
        const body = JSON.stringify({ type: "genui.refresh", environment: options.suffix ?? "prod", revision: catalog.revision() });
        await fetch(options.refreshUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(3000),
        }).catch((error: Error) => log(`refresh URL failed: ${error.message}`));
      }
    });
  };
  const files = [options.theme, options.instructions].filter((path): path is string => !!path);
  closers.push(watchPaths({ dirs: options.dirs, files }, reload, log));

  let url: string | undefined;
  if (options.stdio) {
    await mcp.connect(new StdioServerTransport());
  } else {
    const hostname = options.host ?? "127.0.0.1";
    const server = await new Promise<ServerType>((done, fail) => {
      const started: ServerType = listen({ fetch: mcp.fetch, port: options.port ?? 4100, hostname }, () => done(started));
      started.on("error", fail);
    });
    const { port } = server.address() as AddressInfo;
    url = `http://${hostname === "0.0.0.0" || hostname === "127.0.0.1" ? "localhost" : hostname}:${port}/mcp`;
    closers.push(() => new Promise<void>((done) => server.close(() => done())));
  }

  return {
    url,
    catalog,
    mcp,
    async close() {
      for (const close of closers.reverse()) await close();
    },
  };
}
