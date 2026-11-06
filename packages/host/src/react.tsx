import { stripUiResources } from "./request.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppBridge, PostMessageTransport, type McpUiHostContext, type McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import { useChat } from "@tanstack/ai-react";
import { fetchServerSentEvents, type ConnectionAdapter, type FetchConnectionOptions, type UIMessage } from "@tanstack/ai-client";
import type { UIResourcePart } from "@tanstack/ai";

export type { UIMessage, ConnectionAdapter } from "@tanstack/ai-client";
export type { UIResourcePart } from "@tanstack/ai";
export { useChat, fetchServerSentEvents };

/** TanStack SSE transport with UI-resource HTML/private metadata removed from outgoing history. */
export function createAppMcpConnection(endpoint: string, options: FetchConnectionOptions = {}) {
  const fetchClient = options.fetchClient ?? globalThis.fetch;
  return fetchServerSentEvents(endpoint, {
    ...options,
    credentials: options.credentials ?? "include",
    fetchClient: (input, init) =>
      fetchClient(input, typeof init?.body === "string" ? { ...init, body: stripUiResources(init.body) } : init),
  });
}

export interface AppMcpViewProps {
  part: UIResourcePart;
  sandboxUrl: string;
  hostContext?: McpUiHostContext;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onSendMessage?: (text: string) => Promise<void>;
  onUpdateContext?: (text: string) => Promise<void>;
  onError?: (error: Error) => void;
}

/** Standard MCP Apps host; components and the JSON-RPC bridge stay protocol-compatible. */
export function AppMcpView(props: AppMcpViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const bridgeRef = useRef<AppBridge | null>(null);
  const readyRef = useRef(false);
  const [error, setError] = useState("");
  const { part, sandboxUrl } = props;
  useEffect(() => {
    const { part, hostContext, onSendMessage, onUpdateContext } = live.current;
    const node = container.current;
    if (!node) return;
    const url = new URL(sandboxUrl, window.location.href);
    if (url.origin === window.location.origin) {
      setError("The app-mcp sandbox must use a separate, cookieless origin");
      return;
    }
    const resourceMeta = part.meta?.resourceMeta as { ui?: { csp?: McpUiResourceCsp } } | undefined;
    const csp = resourceMeta?.ui?.csp;
    if (csp) url.searchParams.set("csp", JSON.stringify(csp));
    let html = part.resource.text ?? "";
    try {
      if (!html && part.resource.blob)
        html = new TextDecoder().decode(Uint8Array.from(atob(part.resource.blob), (char) => char.charCodeAt(0)));
    } catch {
      setError("Invalid UI resource encoding");
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.title = part.toolName;
    iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
    iframe.style.cssText = "width:100%;height:440px;border:0;display:block";
    const bridge = new AppBridge(
      null,
      { name: "app-mcp-host", version: "0.3.0" },
      {
        serverTools: {},
        openLinks: {},
        logging: {},
        ...(onSendMessage ? { message: { text: {} } } : {}),
        ...(onUpdateContext ? { updateModelContext: { text: {} } } : {}),
      },
      { hostContext },
    );
    bridgeRef.current = bridge;
    let disposed = false;
    const fail = (cause: unknown) => {
      if (!disposed) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err.message);
        live.current.onError?.(err);
      }
    };
    const timer = setTimeout(() => fail(new Error("The widget did not initialize. Check the sandbox URL.")), 15000);
    bridge.onsandboxready = () => {
      void bridge.sendSandboxResourceReady({ html, csp }).catch(fail);
    };
    bridge.oninitialized = () => {
      clearTimeout(timer);
      readyRef.current = true;
      void (async () => {
        await bridge.sendToolInput({ arguments: (part.meta?.input ?? {}) as Record<string, unknown> });
        await bridge.sendToolResult((part.meta?.result ?? { content: [] }) as Parameters<AppBridge["sendToolResult"]>[0]);
      })().catch(fail);
    };
    bridge.onsizechange = ({ height }) => {
      if (height) iframe.style.height = `${Math.max(100, Math.min(height, 1600))}px`;
    };
    bridge.oncalltool = async ({ name, arguments: args }) =>
      (await live.current.callTool(name, args ?? {})) as Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;
    bridge.onmessage = async ({ content }) => {
      if (!live.current.onSendMessage) return { isError: true };
      await live.current.onSendMessage(textBlocks(content));
      return {};
    };
    bridge.onupdatemodelcontext = async ({ content }) => {
      if (!live.current.onUpdateContext) throw new Error("Context updates unavailable");
      await live.current.onUpdateContext(textBlocks(content ?? []));
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      const link = new URL(url);
      if (!["http:", "https:"].includes(link.protocol)) return { isError: true };
      window.open(link.href, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: "inline" });
    node.replaceChildren(iframe);
    void bridge
      .connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!))
      .then(() => {
        if (!disposed) iframe.src = url.href;
      })
      .catch(fail);
    return () => {
      disposed = true;
      readyRef.current = false;
      clearTimeout(timer);
      bridgeRef.current = null;
      void bridge.close();
      iframe.remove();
    };
  }, [part.toolCallId, part.resource.uri, sandboxUrl]);
  const contextKey = JSON.stringify(props.hostContext);
  useEffect(() => {
    const bridge = bridgeRef.current;
    const hostContext = live.current.hostContext;
    if (bridge && readyRef.current && hostContext) void Promise.resolve(bridge.sendHostContextChange(hostContext)).catch(() => {});
  }, [contextKey]);
  return (
    <div data-app-mcp-view="">
      <div ref={container} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function textBlocks(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export interface AppMcpChatProps {
  endpoint?: string;
  connection?: ConnectionAdapter;
  threadId: string;
  initialMessages?: UIMessage[];
  sandboxUrl: string;
  callTool: AppMcpViewProps["callTool"];
  onUpdateContext?: AppMcpViewProps["onUpdateContext"];
  hostContext?: AppMcpViewProps["hostContext"];
  labels?: { placeholder: string; send: string; stop: string; retry: string; working: string };
  renderText?: (text: string) => ReactNode;
  className?: string;
}

/** Optional ready-to-style chat. Use useAppMcpChat + AppMcpView for your own UI. */
export function useAppMcpChat(props: Pick<AppMcpChatProps, "endpoint" | "connection" | "threadId" | "initialMessages">) {
  const connection = useMemo(
    () => props.connection ?? createAppMcpConnection(props.endpoint ?? "/api/assistant"),
    [props.connection, props.endpoint],
  );
  return useChat({ threadId: props.threadId, connection, initialMessages: props.initialMessages });
}

export function AppMcpChat(props: AppMcpChatProps) {
  const chat = useAppMcpChat(props);
  const [text, setText] = useState("");
  const labels = props.labels ?? {
    placeholder: "What would you like to make?",
    send: "Send",
    stop: "Stop",
    retry: "Retry",
    working: "Working…",
  };
  return (
    <section className={props.className} aria-label="AI chat" data-app-mcp-chat="">
      <div role="log" aria-live="polite">
        {chat.messages.map((message) => (
          <article key={message.id} data-role={message.role}>
            {message.parts.map((part, index) => {
              if (part.type === "text") return <div key={index}>{props.renderText?.(part.content) ?? part.content}</div>;
              if (part.type === "ui-resource")
                return (
                  <AppMcpView
                    key={part.toolCallId}
                    part={part}
                    sandboxUrl={props.sandboxUrl}
                    hostContext={props.hostContext}
                    callTool={props.callTool}
                    onSendMessage={chat.sendMessage}
                    onUpdateContext={props.onUpdateContext}
                  />
                );
              if (part.type === "tool-call")
                return (
                  <details key={index}>
                    <summary>{part.name}</summary>
                  </details>
                );
              return null;
            })}
          </article>
        ))}
      </div>
      {chat.error && (
        <p role="alert">
          {chat.error.message}{" "}
          <button type="button" onClick={() => void chat.reload()}>
            {labels.retry}
          </button>
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || chat.isLoading) return;
          void chat.sendMessage(text);
          setText("");
        }}
      >
        <textarea
          aria-label={labels.placeholder}
          placeholder={labels.placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={chat.isLoading}
        />
        {chat.isLoading ? (
          <button type="button" onClick={() => chat.stop()}>
            {labels.stop}
          </button>
        ) : (
          <button disabled={!text.trim()}>{labels.send}</button>
        )}
      </form>
    </section>
  );
}
