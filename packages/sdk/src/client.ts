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

export type Channel = "stable" | "beta";
export const CHANNELS: readonly Channel[] = ["stable", "beta"];

export interface GenUIClientOptions {
  /** The workspace's end-user MCP, e.g. https://mcp.genui.example/w/<workspace>/mcp, or your self-hosted genui. */
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

/** What genui offers on a channel: the tools and prompts to mirror onto your server. */
export interface Snapshot {
  tools: Tool[];
  prompts: Prompt[];
}

export interface GenUIClient {
  /** Resolves after the first load attempt, successful or not. */
  ready(): Promise<void>;
  /** The channel's current tools and prompts, or undefined if genui was never reached. */
  snapshot(channel: Channel): Snapshot | undefined;
  /** A `ui://` resource a current tool points at. Content-hashed, so fetched once. */
  resource(uri: string): ReadResourceResult | undefined;
  readResource(channel: Channel, uri: string): Promise<ReadResourceResult>;
  /** Forwards a call to genui. When genui can't be reached, returns an error result the model can relay. */
  callTool(channel: Channel, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  getPrompt(channel: Channel, name: string, args: Record<string, string>): Promise<GetPromptResult>;
  refresh(): Promise<void>;
  /** Called when a channel's tools or prompts change. Returns an unsubscribe function. */
  onChange(listener: (channel: Channel) => void): () => void;
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
  const snapshots: Partial<Record<Channel, Snapshot>> = {};
  const resources = new Map<string, ReadResourceResult>();
  const connections = new Map<Channel, Promise<Client>>();
  const listeners = new Set<(channel: Channel) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function connection(channel: Channel): Promise<Client> {
    const existing = connections.get(channel);
    if (existing) return existing;
    const client = (async () => {
      const created = new Client({ name: "genui-sdk", version: "0.1.0" });
      const headers = { authorization: `Bearer ${options.token}`, "x-genui-channel": channel };
      await created.connect(new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers }, fetch: options.fetch }));
      return created;
    })();
    connections.set(channel, client);
    // A failed connection is retried on the next request.
    client.catch(() => drop(channel, client));
    return client;
  }

  function drop(channel: Channel, client: Promise<Client>) {
    if (connections.get(channel) === client) connections.delete(channel);
  }

  /** Runs a request; on a transport failure the connection is dropped so the next request reconnects. */
  async function request<T>(channel: Channel, run: (client: Client) => Promise<T>): Promise<T> {
    const pending = connection(channel);
    const client = await pending;
    try {
      return await run(client);
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        drop(channel, pending);
        client.close().catch(() => {});
      }
      throw error;
    }
  }

  async function load(channel: Channel): Promise<void> {
    const { tools, prompts } = await request(channel, async (client) => ({
      tools: (await client.listTools(undefined, { timeout, cacheMode: "refresh" })).tools,
      // No prompts capability until the workspace has recipes.
      prompts: client.getServerCapabilities()?.prompts ? (await client.listPrompts(undefined, { timeout, cacheMode: "refresh" })).prompts : [],
    }));
    for (const tool of tools) {
      const uri = resourceUri(tool);
      if (uri && !resources.has(uri)) resources.set(uri, await request(channel, (client) => client.readResource({ uri }, { timeout })));
    }
    const next = { tools, prompts };
    if (JSON.stringify(snapshots[channel]) === JSON.stringify(next)) return;
    snapshots[channel] = next;
    for (const listener of listeners) listener(channel);
  }

  async function refresh(): Promise<void> {
    const results = await Promise.allSettled(CHANNELS.map(load));
    results.forEach((r, i) => {
      if (r.status === "rejected") logger.warn(`[genui] could not list genui's ${CHANNELS[i]} tools, keeping the current ones: ${r.reason}`);
    });
    // Keep only the resources current tools point at; old ones are read from genui when asked for.
    const wanted = new Set(Object.values(snapshots).flatMap((s) => s.tools.map(resourceUri)));
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
    snapshot: (channel) => snapshots[channel],
    resource: (uri) => resources.get(uri),
    async readResource(channel, uri) {
      return resources.get(uri) ?? request(channel, (client) => client.readResource({ uri }, { timeout }));
    },
    async callTool(channel, name, args) {
      try {
        return await request(channel, (client) => client.callTool({ name, arguments: args }, { timeout }));
      } catch (error) {
        // genui answered with an error: let it surface as the tool's error.
        if (error instanceof ProtocolError) throw error;
        logger.warn(`[genui] ${name} failed, genui unreachable: ${error}`);
        return { isError: true, content: [{ type: "text", text: UNAVAILABLE_TEXT }] };
      }
    },
    async getPrompt(channel, name, args) {
      try {
        return await request(channel, (client) => client.getPrompt({ name, arguments: args }, { timeout }));
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
      for (const client of connections.values()) client.then((c) => c.close()).catch(() => {});
      connections.clear();
    },
  };
}
