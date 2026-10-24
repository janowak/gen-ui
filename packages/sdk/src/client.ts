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

export interface GenUIClientOptions {
  /**
   * One environment's end-user MCP, on genui's cloud or your self-hosted genui:
   * https://mcp.genui.example/w/<workspace>/mcp for prod, /w/<workspace>/<environment>/mcp for the others.
   * The URL alone picks the environment; to serve two, connect twice.
   */
  url: string;
  /** Workspace server token (scope: server). */
  token: string;
  /** How often to re-list genui's tools and prompts. Default 30s; 0 disables polling. */
  refreshSeconds?: number;
  /** Timeout for a forwarded call. Default 10s. */
  timeoutSeconds?: number;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

/** What genui offers: the tools and prompts to mirror onto your server. */
export interface Snapshot {
  tools: Tool[];
  prompts: Prompt[];
}

export interface GenUIClient {
  /** Resolves after the first load attempt, successful or not. */
  ready(): Promise<void>;
  /** The current tools and prompts, or undefined if genui was never reached. */
  snapshot(): Snapshot | undefined;
  /** A `ui://` resource a current tool points at. Content-hashed, so fetched once. */
  resource(uri: string): ReadResourceResult | undefined;
  readResource(uri: string): Promise<ReadResourceResult>;
  /** Forwards a call to genui. When genui can't be reached, returns an error result the model can relay. */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  getPrompt(name: string, args: Record<string, string>): Promise<GetPromptResult>;
  refresh(): Promise<void>;
  /** Called when the tools or prompts change. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  close(): void;
}

export const UNAVAILABLE_TEXT = "genui is unavailable right now, try again shortly.";

/** `ui://` resource a tool renders into (MCP Apps). */
export function resourceUri(tool: Tool): string | undefined {
  const uri = (tool._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * Connects to genui's end-user MCP. Tools and prompts are listed in the background and kept in
 * memory, so listing them on your server costs no round trip; `ui://` resources are fetched once.
 * Calls always go to genui.
 */
export function connectGenUI(options: GenUIClientOptions): GenUIClient {
  const logger = options.logger ?? console;
  const timeout = (options.timeoutSeconds ?? 10) * 1000;
  let snapshot: Snapshot | undefined;
  const resources = new Map<string, ReadResourceResult>();
  let connection: Promise<Client> | undefined;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function connect(): Promise<Client> {
    if (connection) return connection;
    const client = (async () => {
      const created = new Client({ name: "genui-sdk", version: "0.1.0" });
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
    const { tools, prompts } = await request(async (client) => ({
      tools: (await client.listTools(undefined, { timeout, cacheMode: "refresh" })).tools,
      // No prompts capability until the environment has recipes.
      prompts: client.getServerCapabilities()?.prompts ? (await client.listPrompts(undefined, { timeout, cacheMode: "refresh" })).prompts : [],
    }));
    for (const tool of tools) {
      const uri = resourceUri(tool);
      if (uri && !resources.has(uri)) resources.set(uri, await request((client) => client.readResource({ uri }, { timeout })));
    }
    const next = { tools, prompts };
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<void> {
    try {
      await load();
    } catch (error) {
      logger.warn(`[genui] could not list genui's tools, keeping the current ones: ${error}`);
    }
    // Keep only the resources current tools point at; old ones are read from genui when asked for.
    const wanted = new Set(snapshot?.tools.map(resourceUri));
    for (const uri of resources.keys()) if (!wanted.has(uri)) resources.delete(uri);
  }

  const initial = refresh();
  const interval = options.refreshSeconds ?? 30;
  if (interval > 0) {
    timer = setInterval(() => void refresh(), interval * 1000);
    timer.unref?.();
  }

  return {
    ready: () => initial,
    snapshot: () => snapshot,
    resource: (uri) => resources.get(uri),
    async readResource(uri) {
      return resources.get(uri) ?? request((client) => client.readResource({ uri }, { timeout }));
    },
    async callTool(name, args) {
      try {
        return await request((client) => client.callTool({ name, arguments: args }, { timeout }));
      } catch (error) {
        // genui answered with an error: let it surface as the tool's error.
        if (error instanceof ProtocolError) throw error;
        logger.warn(`[genui] ${name} failed, genui unreachable: ${error}`);
        return { isError: true, content: [{ type: "text", text: UNAVAILABLE_TEXT }] };
      }
    },
    async getPrompt(name, args) {
      try {
        return await request((client) => client.getPrompt({ name, arguments: args }, { timeout }));
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        logger.warn(`[genui] prompt ${name} failed, genui unreachable: ${error}`);
        throw new Error(UNAVAILABLE_TEXT);
      }
    },
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (timer) clearInterval(timer);
      listeners.clear();
      connection?.then((c) => c.close()).catch(() => {});
      connection = undefined;
    },
  };
}
