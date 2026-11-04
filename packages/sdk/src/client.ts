import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/client";

export interface AppMcpClientOptions {
  /**
   * One environment's end-user MCP, on app-mcp's cloud or your self-hosted app-mcp:
   * https://mcp.app-mcp.example/w/<workspace>/mcp for prod, /w/<workspace>/<environment>/mcp for the others.
   * The URL alone picks the environment; to serve two, connect twice.
   */
  url: string;
  /** Workspace server token (scope: server). */
  token: string;
  /**
   * When app-mcp's tools are used and the copy is older than this, a check runs in the background:
   * one small request, and a re-list only if app-mcp changed. Default 60s; 0 checks only on refresh().
   */
  refreshSeconds?: number;
  /** Timeout for a forwarded call. Default 10s. */
  timeoutSeconds?: number;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

/** What app-mcp offers: the tools and prompts to mirror onto your server, and the environment's instructions. */
export interface Snapshot {
  tools: Tool[];
  prompts: Prompt[];
  /** The MCP instructions set for this environment in app-mcp, if any. */
  instructions?: string;
}

export interface AppMcpClient {
  /** Resolves after the first load attempt, successful or not. */
  ready(): Promise<void>;
  /** The current tools and prompts, or undefined if app-mcp was never reached. */
  snapshot(): Snapshot | undefined;
  /**
   * The environment's MCP instructions from app-mcp, for your server's own instructions
   * (`new McpServer(info, { instructions })`). Hosts read them when they connect, so a long-lived
   * server picks up a change at its next start; per-request servers pick it up right away.
   */
  instructions(): string | undefined;
  /** A `ui://` resource a current tool points at. Content-hashed, so fetched once. */
  resource(uri: string): ReadResourceResult | undefined;
  readResource(uri: string): Promise<ReadResourceResult>;
  /** Forwards a call to app-mcp. When app-mcp can't be reached, returns an error result the model can relay. */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  getPrompt(name: string, args: Record<string, string>): Promise<GetPromptResult>;
  /** The environment revision the current tools come from, or undefined before the first load. */
  revision(): number | undefined;
  /**
   * Checks app-mcp's revision and re-lists its tools if it changed. With `atLeast`, does nothing when
   * this client already has that revision. Concurrent calls share one check.
   */
  refresh(atLeast?: number): Promise<void>;
  /** Called when the tools or prompts change. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  close(): void;
}

export const UNAVAILABLE_TEXT = "app-mcp is unavailable right now, try again shortly.";

/** `ui://` resource a tool renders into (MCP Apps). */
export function resourceUri(tool: Tool): string | undefined {
  const uri = (tool._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * Connects to app-mcp's end-user MCP. Tools and prompts are listed in the background and kept in
 * memory, so listing them on your server costs no round trip; `ui://` resources are fetched once.
 * Calls always go to app-mcp. The copy is checked in the background when it's used and older than
 * `refreshSeconds`, and right away when app-mcp calls your refresh endpoint (`refreshHandler`).
 */
export function connectAppMcp(options: AppMcpClientOptions): AppMcpClient {
  const logger = options.logger ?? console;
  const timeout = (options.timeoutSeconds ?? 10) * 1000;
  const maxAge = (options.refreshSeconds ?? 60) * 1000;
  // The environment's revision sits next to its MCP: .../mcp → .../revision.
  const revisionUrl = /\/mcp\/?$/.test(options.url) ? options.url.replace(/\/mcp\/?$/, "/revision") : undefined;
  let snapshot: Snapshot | undefined;
  let revision: number | undefined;
  let checkedAt = 0;
  const resources = new Map<string, ReadResourceResult>();
  let connection: Promise<Client> | undefined;
  const listeners = new Set<() => void>();

  function connect(): Promise<Client> {
    if (connection) return connection;
    const client = (async () => {
      const created = new Client({ name: "app-mcp-sdk", version: "0.1.0" });
      const headers = { authorization: `Bearer ${options.token}` };
      await created.connect(new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers }, fetch: options.fetch }));
      return created;
    })();
    connection = client;
    // A failed connection is retried on the next request.
    client.catch(() => drop(client));
    return client;
  }

  function drop(client: Promise<Client>) {
    if (connection === client) connection = undefined;
  }

  /** Runs a request; on a transport failure the connection is dropped so the next request reconnects. */
  async function request<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const pending = connect();
    const client = await pending;
    try {
      return await run(client);
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        drop(pending);
        client.close().catch(() => {});
      }
      throw error;
    }
  }

  async function load(): Promise<void> {
    const { tools, prompts, instructions } = await request(async (client) => ({
      tools: (await client.listTools(undefined, { timeout, cacheMode: "refresh" })).tools,
      // No prompts capability until the environment has a workflow with params.
      prompts: client.getServerCapabilities()?.prompts
        ? (await client.listPrompts(undefined, { timeout, cacheMode: "refresh" })).prompts
        : [],
      instructions: client.getInstructions(),
    }));
    for (const tool of tools) {
      const uri = resourceUri(tool);
      if (uri && !resources.has(uri)) resources.set(uri, await request((client) => client.readResource({ uri }, { timeout })));
    }
    const next: Snapshot = { tools, prompts, ...(instructions ? { instructions } : {}) };
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /** app-mcp's current revision of this environment; undefined when the URL has no `/revision` next to it. */
  async function latestRevision(): Promise<number | undefined> {
    if (!revisionUrl) return undefined;
    const res = await (options.fetch ?? fetch)(revisionUrl, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${revisionUrl}`);
    return ((await res.json()) as { revision: number }).revision;
  }

  async function check(): Promise<void> {
    checkedAt = Date.now();
    try {
      const latest = await latestRevision();
      if (snapshot && latest !== undefined && latest === revision) return;
      // Instructions come with the connection: reconnect so a change to them is seen too.
      if (snapshot && latest !== undefined && connection) {
        const stale = connection;
        drop(stale);
        stale.then((client) => client.close()).catch(() => {});
      }
      await load();
      revision = latest;
    } catch (error) {
      logger.warn(`[app-mcp] could not list app-mcp's tools, keeping the current ones: ${error}`);
    }
    // Keep only the resources current tools point at; old ones are read from app-mcp when asked for.
    const wanted = new Set(snapshot?.tools.map(resourceUri));
    for (const uri of resources.keys()) if (!wanted.has(uri)) resources.delete(uri);
    // Never loaded (app-mcp down or a bad token at start): no app-mcp tool is mounted to be used, so retry on a timer.
    if (!snapshot && maxAge > 0 && !closed) {
      retry = setTimeout(() => void refresh(), maxAge);
      retry.unref?.();
    }
  }

  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  function refresh(atLeast?: number): Promise<void> {
    if (atLeast !== undefined && revision !== undefined && revision >= atLeast) return Promise.resolve();
    if (!running) {
      running = check().finally(() => {
        running = undefined;
      });
      return running;
    }
    // The running check may have read the revision before this change: one more check follows it.
    queued ??= running.then(() => {
      queued = undefined;
      return refresh();
    });
    return queued;
  }

  /** A host is using app-mcp's tools: an old copy is checked in the background, never delaying the caller. */
  function used(): void {
    if (maxAge > 0 && !running && Date.now() - checkedAt > maxAge) void refresh();
  }

  const initial = refresh();

  return {
    ready: () => initial,
    snapshot: () => snapshot,
    instructions: () => snapshot?.instructions,
    resource: (uri) => resources.get(uri),
    async readResource(uri) {
      used();
      return resources.get(uri) ?? request((client) => client.readResource({ uri }, { timeout }));
    },
    async callTool(name, args) {
      used();
      try {
        return await request((client) => client.callTool({ name, arguments: args }, { timeout }));
      } catch (error) {
        // app-mcp answered with an error: let it surface as the tool's error.
        if (error instanceof ProtocolError) throw error;
        logger.warn(`[app-mcp] ${name} failed, app-mcp unreachable: ${error}`);
        return { isError: true, content: [{ type: "text", text: UNAVAILABLE_TEXT }] };
      }
    },
    async getPrompt(name, args) {
      used();
      try {
        return await request((client) => client.getPrompt({ name, arguments: args }, { timeout }));
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        logger.warn(`[app-mcp] prompt ${name} failed, app-mcp unreachable: ${error}`);
        throw new Error(UNAVAILABLE_TEXT);
      }
    },
    revision: () => revision,
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      clearTimeout(retry);
      listeners.clear();
      connection?.then((c) => c.close()).catch(() => {});
      connection = undefined;
    },
  };
}
