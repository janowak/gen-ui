/**
 * One structured line per end-user MCP request, for Workers Logs (observability in wrangler.jsonc) and
 * `docker compose logs`. Names only: tool arguments, results and resource contents are the end user's
 * data and never appear in a line.
 */

export interface McpLogLine {
  event: "mcp";
  workspace: string;
  environment: string;
  /** "server": a company's MCP server through @app-mcp/sdk (server token). "public": a chat host directly. */
  caller: "server" | "public";
  /** JSON-RPC method, e.g. "tools/call". Several for a batch, comma-separated. */
  method?: string;
  /** For tools/call: the tool. */
  tool?: string;
  /** For resources/read: the ui:// URI. */
  resource?: string;
  /** For prompts/get: the workflow command. */
  prompt?: string;
  /** Size of the tool arguments in bytes; never their content. */
  argBytes?: number;
  /** For initialize: the host's clientInfo, e.g. "claude-ai 0.1.0". */
  client?: string;
  /** Request's user agent, trimmed. */
  ua?: string;
  status: number;
  /** "ok"; "error" (JSON-RPC error); "tool_error" (the tool returned isError); "rejected" (never reached the MCP). */
  outcome: "ok" | "error" | "tool_error" | "rejected";
  /** For error, tool_error and rejected: what went wrong, trimmed. */
  error?: string;
  ms: number;
}

export type McpLogger = (line: McpLogLine) => void;

/** JSON on one line: Workers Logs turns it into searchable fields. */
export const consoleMcpLogger: McpLogger = (line) => console.log(JSON.stringify(line));

const trim = (value: string, max = 200) => (value.length > max ? `${value.slice(0, max)}…` : value);

type RpcMessage = { method?: unknown; params?: Record<string, unknown> };

/** What a request asks for, read from a copy of its body. Names and sizes only. */
export async function describeMcpRequest(request: Request): Promise<Partial<McpLogLine>> {
  const ua = request.headers.get("user-agent");
  const described: Partial<McpLogLine> = ua ? { ua: trim(ua, 120) } : {};
  if (request.method !== "POST") return { ...described, method: request.method };
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return described;
  }
  const messages = (Array.isArray(body) ? body : [body]).filter((m): m is RpcMessage => typeof m === "object" && m !== null);
  const methods = messages.map((m) => m.method).filter((m): m is string => typeof m === "string");
  if (methods.length) described.method = methods.join(",");
  for (const { method, params = {} } of messages) {
    if (method === "tools/call") {
      if (typeof params.name === "string") described.tool = params.name;
      if (params.arguments !== undefined) described.argBytes = JSON.stringify(params.arguments).length;
    } else if (method === "resources/read" && typeof params.uri === "string") {
      described.resource = trim(params.uri);
    } else if (method === "prompts/get" && typeof params.name === "string") {
      described.prompt = params.name;
    } else if (method === "initialize") {
      const info = params.clientInfo as { name?: unknown; version?: unknown } | undefined;
      if (typeof info?.name === "string")
        described.client = trim(`${info.name} ${typeof info.version === "string" ? info.version : ""}`.trim(), 80);
    }
  }
  return described;
}

/** The JSON-RPC messages in a response: plain JSON, or the `data:` lines of an event stream. */
function messagesIn(text: string, contentType: string): unknown[] {
  const chunks = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  return chunks.flatMap((chunk) => {
    try {
      const parsed = JSON.parse(chunk) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
}

/** How a response went, from a copy of its body. */
export async function mcpOutcome(response: Response): Promise<Pick<McpLogLine, "outcome" | "error">> {
  if (response.status >= 400 && !response.body) return { outcome: "error", error: `HTTP ${response.status}` };
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return { outcome: response.status >= 400 ? "error" : "ok" };
  }
  for (const message of messagesIn(text, response.headers.get("content-type") ?? "")) {
    const { error, result } = message as { error?: { message?: unknown }; result?: { isError?: unknown; content?: unknown } };
    if (error) return { outcome: "error", error: trim(typeof error.message === "string" ? error.message : JSON.stringify(error)) };
    if (result?.isError === true) {
      const first = Array.isArray(result.content) ? (result.content[0] as { text?: unknown } | undefined) : undefined;
      return { outcome: "tool_error", ...(typeof first?.text === "string" ? { error: trim(first.text) } : {}) };
    }
  }
  if (response.status >= 400) return { outcome: "error", error: trim(text || `HTTP ${response.status}`) };
  return { outcome: "ok" };
}
