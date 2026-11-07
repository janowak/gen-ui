# Embed your MCP experience

Build tools and interactive components once. Use them in external assistants and in your own application.

`@app-mcp/host` combines TanStack AI's streaming/model loop with standard MCP Apps rendering. It works with existing MCP servers; components remain portable to Claude, ChatGPT and other MCP Apps hosts.

## Install

```sh
pnpm add @app-mcp/host react react-dom
```

## Server

Authenticate the request in your application first. Create a session **per verified caller**, using that person's MCP connection. For an existing in-process SDK server:

```ts
import { createEmbeddedSession, localMcpTransport, createCloudflareText, toServerSentEventsResponse } from '@app-mcp/host/server'

const mcp = await createEmbeddedSession({
  transport: await localMcpTransport(await createMyMcpServer(verifiedUser)),
  modelTools: ['search', 'render_editor'],
  appTools: ['editor_data', 'editor_save'],
})
async function* respond() {
  try {
    yield* mcp.stream({
      adapter: createCloudflareText('@cf/zai-org/glm-4.7-flash', { accountId, apiKey }),
      threadId,
      messages: trustedHistory,
    })
  } finally { await mcp.close() }
}
return toServerSentEventsResponse(respond())
```

Remote connections use `transport: { type: 'http', url, headers }`. Never accept arbitrary server URLs or tokens from unauthenticated requests. The app-mcp registry credential belongs behind your MCP server, not in the browser.

The session loads MCP instructions, tools and UI resources. Model-only and app-only visibility are respected; model and widget tools have separate explicit allowlists. Your MCP tools must still validate ownership and permissions. The host does not grant access.

Sessions default to eight model turns, 24 tool calls and, for Cloudflare, 2048 output tokens per model request. Other adapters accept their provider-specific `modelOptions`. One model turn is reserved for a tool-free summary if the tool loop exhausts its turn budget: the model gets the conversation and the turn's tool work as a plain-text log (not tool-call history, which some models such as gpt-oss answer with another tool call) and writes a short status report. Only its text reaches the stream; if it still writes none, the stream ends with `summaryFallback` (an English default otherwise), so a turn never ends without a reply. Pass `signal`, `maxTurns`, `maxToolCalls`, `maxTokens` and optional `reasoning` to configure them. Close in `finally`, after consuming the stream. Configure the chosen adapter's timeout/retry policy separately.

## React

```tsx
import { AppMcpChat } from '@app-mcp/host'

<AppMcpChat
  endpoint="/api/assistant"
  threadId={threadId}
  sandboxUrl="https://widgets.example.net/sandbox"
  hostContext={{ theme: 'light' }}
  callTool={(name, args) => authenticatedApi.callWidget({ threadId, name, args })}
  onUpdateContext={text => authenticatedApi.saveWidgetContext({ threadId, text })}
/>
```

Your widget endpoint authenticates again, checks conversation ownership, creates the same caller-scoped session and invokes `session.callTool(name, args)`. Never expose a generic unrestricted tools/call proxy.

For an existing chat UI use `useAppMcpChat`, `AppMcpView`, and `createAppMcpConnection`. The default connection strips UI-resource HTML and private metadata from follow-up request history. The native TanStack connection helpers are also exported for custom transports. `AppMcpView` also works without chat: call `session.render("render_editor", args)` on your authenticated backend and pass the returned `part` to the component. For a custom transport, pass a `UIResourcePart` with resource HTML and `meta: { input, result, resourceMeta }`. `result` is the original MCP result, including private `_meta`; `resourceMeta` is the UI resource's metadata, including its declared CSP. Do not send either to the model.

`AppMcpChat` is deliberately unstyled: `data-app-mcp-chat` and `data-role` support styling, `labels` supports translation, and `renderText` accepts your Markdown renderer. The lower-level hook exposes normal TanStack send/stop/reload and messages APIs.

## Sandbox deployment

Serve `sandboxResponse(request, ['https://app.example.com'])` from `@app-mcp/host/sandbox` on a **dedicated cookieless origin**, separate from your app and API. Avoid a domain covered by your app's Domain cookies. Point `sandboxUrl` at this route. The renderer rejects the app's own origin.

The sandbox enforces frame ancestors, declared resource/connection origins, and source-checked message routing. Missing permissions fail closed. It never receives API credentials. Declare external asset origins in `defineComponent({ csp: { resourceDomains: [...] } })`; declarations merge with registry asset CDN origins.

For localhost use `http://localhost` for the application and `http://127.0.0.1` on a separate port for the sandbox. Both servers must be running. Production should use HTTPS for both.

## Persistence and retries

You own your database and conversation access policy. Treat browser messages as user input, not authoritative history. Persist trusted messages/tool results server-side. Persist the emitted UI-resource metadata alongside messages to replay an editor without rerunning its original tool.

Use `executeTool` on `createEmbeddedSession` for a durable tool execution journal. It receives `{ name, args, toolCallId, run }`; claim the execution before `run()` and store its result afterwards. An interrupted write is uncertain: inspect existing state rather than automatically repeating it. A completed request retry should replay stored stream chunks. Context updates from widgets are untrusted data, not system instructions.

Signed image URLs and editable view sessions may expire; the component should refresh its authorised data when reopened. Keep versioned UI resources available for old conversations.

## Runnable starter

`examples/embedded-chat` contains a complete local Vite + Hono + Cloudflare example. See its README for setup. It is intentionally single-user; production authentication and persistence are application responsibilities.
