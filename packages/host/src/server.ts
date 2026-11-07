import { modelMessagesToUIMessages, convertMessagesToModelMessages } from "@tanstack/ai";
import { StreamProcessor } from "@tanstack/ai-client";
import { InMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { createMCPClient, type MCPClientOptions } from "@tanstack/ai-mcp";
import { chat, maxIterations, type AnyTextAdapter, type ModelMessage, type UIMessage, type StreamChunk } from "@tanstack/ai";

export { createCloudflareText } from "@tanstack/ai-cloudflare";
export { toServerSentEventsResponse } from "@tanstack/ai";
export { createMCPClient } from "@tanstack/ai-mcp";

/** Connect a caller-scoped SDK server without an HTTP round trip or a second login. */
export async function localMcpTransport(server: { connect(transport: Transport): Promise<void> }): Promise<Transport> {
  const [client, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  return client;
}

export interface EmbeddedSessionOptions {
  transport: MCPClientOptions["transport"];
  /** Explicit model tool allowlist. App-only tools are always excluded. */
  modelTools: readonly string[];
  /** Explicit widget tool allowlist. Authorization must still run in the MCP tools. */
  appTools: readonly string[];
  executeTool?: (call: {
    name: string;
    args: Record<string, unknown>;
    toolCallId?: string;
    run: () => Promise<unknown>;
  }) => Promise<unknown>;
}

/** Create per verified caller, never share between users. Close after the stream is consumed. */
export async function createEmbeddedSession(options: EmbeddedSessionOptions) {
  const client = await createMCPClient({
    transport: options.transport,
    toolFilter: (tool) => {
      const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
      return options.modelTools.includes(tool.name) && (!ui?.visibility || ui.visibility.includes("model"));
    },
  });
  const allowedModel = new Set(options.modelTools);
  const allowedApp = new Set(options.appTools);
  const views = new Map<string, Record<string, unknown>>();
  const resources = new Map<string, Awaited<ReturnType<typeof client.readResource>>>();
  const discover = client.tools.bind(client);
  const read = client.readResource.bind(client);
  client.readResource = async (uri, opts) => {
    const resource = await read(uri, opts);
    resources.set(uri, resource);
    return resource;
  };
  client.tools = (async () =>
    (await discover())
      .filter((tool) => allowedModel.has(tool.name))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown, ctx?: { toolCallId?: string; abortSignal?: AbortSignal }) => {
          const args = (input ?? {}) as Record<string, unknown>;
          const run = () => client.callTool(tool.name, args, { signal: ctx?.abortSignal });
          const result = (
            options.executeTool ? await options.executeTool({ name: tool.name, args, toolCallId: ctx?.toolCallId, run }) : await run()
          ) as Awaited<ReturnType<typeof client.callTool>>;
          if (ctx?.toolCallId) views.set(ctx.toolCallId, { input: args, result });
          if (result.isError)
            throw new Error(
              result.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") || "Tool failed",
            );
          return (
            result.structuredContent ??
            result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n") ??
            ""
          );
        },
      }))) as typeof client.tools;

  return {
    instructions: client.instructions,
    async *stream(input: {
      adapter: AnyTextAdapter;
      threadId: string;
      messages: Array<ModelMessage | UIMessage>;
      systemPrompts?: string[];
      signal?: AbortSignal;
      maxTurns?: number;
      maxToolCalls?: number;
      maxTokens?: number;
      modelOptions?: Record<string, unknown>;
      reasoning?: "off" | "low" | "medium" | "high";
      /** Sent when a turn ends on tool work and the closing summary still writes no text. */
      summaryFallback?: string;
    }): AsyncGenerator<StreamChunk> {
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      let calls = 0;
      let needsSummary = false;
      let failed = false;
      const processor = new StreamProcessor();
      processor.setMessages(modelMessagesToUIMessages(convertMessagesToModelMessages(input.messages)));
      try {
        const chunks = chat({
          adapter: input.adapter,
          threadId: input.threadId,
          messages: input.messages,
          systemPrompts: input.systemPrompts ?? [],
          mcp: { clients: [client], connection: "keep-alive" },
          agentLoopStrategy: maxIterations(Math.max(1, (input.maxTurns ?? 8) - 1)),
          toolExecution: "sequential",
          reasoning: input.reasoning,
          modelOptions: input.modelOptions ?? (input.adapter.name === "cloudflare" ? { max_tokens: input.maxTokens ?? 2048 } : undefined),
          abortController: controller,
          middleware: [
            {
              name: "app-mcp-budget",
              onBeforeToolCall() {
                if (++calls > (input.maxToolCalls ?? 24)) return { type: "abort" as const, reason: "Tool call limit reached" };
              },
            },
          ],
        });
        for await (const chunk of chunks) {
          processor.processChunk(chunk);
          if (chunk.type === "TOOL_CALL_START") needsSummary = true;
          if (chunk.type === "TEXT_MESSAGE_CONTENT") needsSummary = false;
          if (chunk.type === "RUN_ERROR") failed = true;
          if (chunk.type === "CUSTOM" && chunk.name === "ui-resource") {
            const value = chunk.value as { toolCallId: string; resource: { uri: string }; meta?: Record<string, unknown> };
            const source = resources.get(value.resource.uri)?.contents.find((c) => c.uri === value.resource.uri);
            yield { ...chunk, value: { ...value, meta: { ...views.get(value.toolCallId), resourceMeta: source?._meta } } };
          } else yield chunk;
        }
        if (needsSummary && !failed && !controller.signal.aborted) {
          processor.finalizeStream();
          // Reserve one model call to report completed/partial work. The work goes in as a plain-text
          // log, not tool-call history: some models (gpt-oss) answer that history with another tool
          // call even when no tools are offered, which leaves the turn with no reply at all.
          const messageId = `summary-${crypto.randomUUID()}`;
          let text = false;
          for await (const chunk of chat({
            adapter: input.adapter,
            threadId: input.threadId,
            messages: [{ role: "user", content: workLog(processor.getMessages()) }],
            // Not the turn's own system prompts: their tool instructions make the model plan more
            // tool work (in its reasoning, or as text) instead of reporting to the user.
            systemPrompts: [SUMMARY_PROMPT],
            modelOptions: input.modelOptions ?? (input.adapter.name === "cloudflare" ? { max_tokens: input.maxTokens ?? 2048 } : undefined),
            reasoning: input.reasoning,
            agentLoopStrategy: maxIterations(1),
            abortController: controller,
          })) {
            if (chunk.type.startsWith("TEXT_MESSAGE_")) {
              if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta.trim()) text = true;
              yield { ...chunk, messageId } as StreamChunk;
            } else if (chunk.type === "RUN_STARTED" || chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
              // Usage and errors still reach the caller; a stray tool call or its reasoning does not.
              yield chunk;
            }
          }
          if (!text && !controller.signal.aborted) {
            const fallbackId = `${messageId}-fallback`;
            const timestamp = Date.now();
            yield* [
              { type: "TEXT_MESSAGE_START", messageId: fallbackId, role: "assistant", timestamp },
              { type: "TEXT_MESSAGE_CONTENT", messageId: fallbackId, delta: input.summaryFallback ?? SUMMARY_FALLBACK, timestamp },
              { type: "TEXT_MESSAGE_END", messageId: fallbackId, timestamp },
            ] as StreamChunk[];
          }
        }
      } finally {
        input.signal?.removeEventListener("abort", abort);
      }
    },
    /** Render the same component directly in your app, without a model or a chat. */
    async render(name: string, args: Record<string, unknown>): Promise<import("@tanstack/ai").UIResourcePart> {
      if (!allowedModel.has(name)) throw new Error("Render tool not allowed");
      const tool = (await client.tools()).find((tool) => tool.name === name);
      const uri = tool?.metadata.mcp.uiResourceUri;
      if (!uri) throw new Error("Tool has no linked UI resource");
      const result = await client.callTool(name, args);
      const loaded = await client.readResource(uri);
      const resource = loaded.contents.find((content) => content.uri === uri);
      if (!resource) throw new Error("Linked UI resource not found");
      return {
        type: "ui-resource",
        toolName: name,
        toolCallId: crypto.randomUUID(),
        resource: {
          uri,
          mimeType: resource.mimeType ?? "text/html",
          text: "text" in resource ? resource.text : undefined,
          blob: "blob" in resource ? resource.blob : undefined,
        },
        meta: { input: args, result, resourceMeta: resource._meta },
      };
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      if (!allowedApp.has(name)) throw new Error("Widget tool not allowed");
      return client.callTool(name, args, { signal });
    },
    async readResource(uri: string) {
      if (!uri.startsWith("ui://")) throw new Error("Only UI resources can be embedded");
      return client.readResource(uri);
    },
    close: () => client.close(),
  };
}

const SUMMARY_PROMPT =
  "An assistant was working on the user's request with tools and hit its step limit before writing anything to the user. The message you receive is the log of that conversation and tool work. Write the assistant's short status report to the user (2–4 sentences, plain text, in the language the user wrote in): what was done (name things created or found), what failed or is unfinished, and that the user can send another message to continue. Report only what the log shows. Do not do the user's task yourself, do not invent results, do not call tools and do not write tool calls.";
const SUMMARY_FALLBACK = "I stopped before finishing this reply. Send another message to continue.";
const LOG_LIMIT = 8000;

/** The conversation and this turn's tool work as plain text, newest last, for the closing summary. */
function workLog(messages: UIMessage[]): string {
  const results = new Map<string, { content: unknown; state?: string }>();
  for (const message of messages) for (const part of message.parts) if (part.type === "tool-result") results.set(part.toolCallId, part);
  const lines: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" && part.content.trim())
        lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${part.content.trim().slice(0, 1500)}`);
      if (part.type === "tool-call") {
        const result = results.get(part.id);
        const outcome = !result
          ? "did not run"
          : `${result.state === "error" ? "failed" : "ok"}: ${(typeof result.content === "string" ? result.content : JSON.stringify(result.content)).slice(0, 300)}`;
        lines.push(`Tool ${part.name}(${part.arguments.slice(0, 200)}) ${outcome}`);
      }
    }
  }
  return lines.join("\n").slice(-LOG_LIMIT);
}

export { StreamProcessor } from "@tanstack/ai-client";
export type { UIMessage, StreamChunk } from "@tanstack/ai";
