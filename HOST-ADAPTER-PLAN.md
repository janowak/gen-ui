# Host adapter plan

Every interaction between an app-mcp view and its host goes through one contract, `AppMcpHost`: render events, tool calls, model context, messages, display modes, links, theme and state. The kit and the built-in views call the contract, never the ext-apps `App` or `window.openai` directly. Today there is one implementation, an adapter over MCP Apps. A company's own chat is the second implementation: `createHost` in `@app-mcp/element`, rendering views in a shadow root (CUSTOM-CHAT-PLAN.md).

**Status (2026-10-26)**
- Proposed. This plan keeps views in MCP Apps iframes. CUSTOM-CHAT-PLAN.md builds on it, and replaces §4's `mount(…, { host })` with `view(component, setup)`.
- Builds on VIEW-STATE-PLAN.md: its state backends become the adapter's `state` (§3). Its phases 4–6 are being built on `App` right now; finish and commit them first, then move them onto the contract (§6, step 2).

**Principle: the contract is MCP Apps as a JavaScript interface.** Render events, tool calls and results keep their MCP shapes, so the adapter stays thin. The contract adds only what views need on top: capabilities up front, a model bridge with a fallback, and per-render state.

---

## 1. Today

| Interaction | Kit (`runtime.ts`, `mount.ts`) | Built-in views (`packages/ui`) |
|---|---|---|
| Render events (partial input, input, result, cancel) | `app.on*` | `useApp` + `created.on*` in `useView` |
| Tool calls | `app.callServerTool` | `callTool(app, …)`: `app` is passed down to `FieldControl`, `ResourceSelect`, `useOptions`, `useSourceData` and the manager, theme and recipes views |
| Model context, messages | `ctx.model.update/send` | `app.updateModelContext` / `app.sendMessage` directly: the form's own `deliver()` (with a fallback the kit lacks), manager, theme, recipes |
| Display mode | `ctx.display` | `app.requestDisplayMode` (theme view) |
| Theme, host styles, fonts | `getHostContext()` → `applyDocumentTheme` etc. | `useHostStyles` + `applyTheme` |
| State | View store attached to `App` events; backend picked from `window.openai` / `localStorage` | Same store, attached in `useView` |
| Size, teardown | `App` (`autoResize`), `onteardown` | `App` |
| Escape hatch | `ctx.app` | `app` everywhere |

Three code paths reach the host, and none of them checks what it supports first.

---

## 2. The contract

`packages/kit/src/host.ts`, exported as `@app-mcp/kit/host`:

```ts
export const HOST_CONTRACT = 1;

export interface AppMcpHost {
  readonly contract: number;                                   // HOST_CONTRACT the host implements
  readonly capabilities: HostCapabilities;
  context(): HostContext;
  subscribe(listener: (event: HostEvent) => void): () => void;

  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
  updateModelContext(text: string): Promise<void>;             // rejects when refused
  sendMessage(text: string): Promise<void>;
  requestDisplayMode(mode: DisplayMode): Promise<DisplayMode>;
  openLink(url: string): Promise<void>;

  /** Per-render state. See VIEW-STATE-PLAN §4. */
  readonly state: StateBackend;
}

export type HostEvent =
  | { type: "input-partial"; args: Record<string, unknown> }
  | { type: "input"; args: Record<string, unknown> }
  | { type: "result"; result: CallToolResult }                 // carries the render id
  | { type: "cancelled" }
  | { type: "context"; context: HostContext }
  | { type: "teardown" };

export interface HostCapabilities {
  tools: boolean;                                              // false in registry previews
  modelContext: boolean;
  messages: boolean;
  links: boolean;
  displayModes: DisplayMode[];
}

export interface HostContext {
  theme: "light" | "dark";
  displayMode: DisplayMode;
  /** Host CSS variables (`--color-*`, `--font-*`) and font CSS, applied by the runtime. */
  styles?: { variables?: Record<string, string>; fonts?: string };
  locale?: string;
}
```

**The model bridge**, built on the contract and used by kit components and built-in views alike:

```ts
export function modelBridge(host: AppMcpHost): {
  can(action: "update" | "send"): boolean;
  update(text: string): Promise<boolean>;                      // false when refused or unsupported
  send(text: string): Promise<boolean>;
  /** Puts `details` in context and posts the short `message`. Without model context, posts the details as the message. */
  deliver(details: string, message: string): Promise<boolean>;
};
```

`deliver` is the form's current `deliver()`, moved here so the fallback exists once.

**The rules:**
- **Capabilities first.** Views read `capabilities` before acting instead of finding out from an error:
  - no `tools` → "unavailable" (today's preview behaviour);
  - no `modelContext` → `deliver` falls back to the message;
  - an unavailable display mode → the button isn't shown.
- **`state` is always there.** A host that keeps nothing passes `memoryBackend`; `persistence` says what the user gets.
- **The version exists from the start.** No compatibility code now, since we're in development. Once a second host exists, contract changes bump `HOST_CONTRACT`.

---

## 3. The MCP Apps adapter

`mcpAppsHost(app)` in `@app-mcp/kit/host` is the only implementation for now:

- **Mapping.** The contract maps onto the `App`:
  - `callServerTool`, `updateModelContext`, `sendMessage`, `requestDisplayMode`, `openLink`;
  - the `toolinputpartial` / `toolinput` / `toolresult` / `toolcancelled` / `hostcontextchanged` events and `onteardown`.
- **Capabilities.** Read from `app.getHostCapabilities()` (`serverTools`, `updateModelContext`, `message`, `openLinks`) and the host context's `availableDisplayModes`. `tools` is also false once a result is flagged `app-mcp/preview` or failed, as `blocked` is today.
- **State,** picked as VIEW-STATE-PLAN §4 describes:
  - ChatGPT's widget state (`privateContent`);
  - else `localStorage`;
  - else memory.
- **ChatGPT-specific code lives here only.** The `window.openai` checks move out of `state.ts`'s `defaultBackend()` into the adapter.
- **Size and teardown** stay inside: `App`'s `autoResize`, and flushing state on teardown.
- **Created before `connect()`.** The host sends the tool result once, so the adapter must listen before connecting.

**Tests** use a plain object that implements `AppMcpHost` (events pushed by hand, calls recorded). Only the adapter's own tests need an `AppBridge`.

---

## 4. Runtime on the contract

**Kit**
- `createRuntime(host, component, onChange)`. `mount` builds `mcpAppsHost(new App(…))`; `options.host` overrides it, for tests.
- `ctx.host` replaces `ctx.app` as the escape hatch.
- `ctx.model` is `modelBridge(host)`: `update`, `send`, `can` and `deliver`.
- `ctx.links.open(url)` is new. Today a component can only open a link through `ctx.app`.
- `ctx.display` and the theme application read `host.context()` and `host.capabilities`.
- The view store attaches to `host.subscribe` instead of `App` events, and gets its backend from `host.state`.

**Built-in views**
- A `HostProvider` creates `mcpAppsHost` once. `useHost()` replaces `useApp` and `useHostStyles`, and `useView` reads its events from the host.
- `app` props become `host`:
  - `FieldControl`, `ResourceSelect`, `useOptions`;
  - `useSourceData`;
  - the manager, theme and recipes views.
- `callTool(app, …)` becomes `host.callTool` (through `runtime/tools.ts`'s result reader, as today).
- The form's submit goes through `host.callTool`, then `modelBridge(host).deliver(summary, short message)`. The form's own `deliver()` goes.
- The manager, theme and recipes views use `modelBridge(host).update(…)` instead of `app.updateModelContext`.
- **Rule: nothing under `packages/ui/src/views` imports `@modelcontextprotocol/ext-apps`.** Only the adapter and the provider do. A lint-style test (grep the imports) keeps it that way.

---

## 5. Risks

1. **The contract becomes the seam for every future host,** so keep it to what views use today, plus `openLink`. No `downloadFile`, resource reads or logging until a view needs them.
2. **Management views move too** (manager, theme, recipes), so there's one code path, though they only ever run in the registry's own connector.
3. **Capability reporting varies by host.** If Claude or ChatGPT leave out a capability they actually support, checking first would turn off a working feature. Add to the M0 checks: what `getHostCapabilities()` reports in each host. Until then, a missing capability falls back to "try it", as today.

---

## 6. Steps

1. **Contract and model bridge.** `host.ts`: the types, `HOST_CONTRACT`, `modelBridge`, and a test host for unit tests.
2. **MCP Apps adapter.**
   - `mcpAppsHost(app)`: mapping, capabilities, the state backend choice moved out of `state.ts`, teardown flush.
   - The view store attaches to `host.subscribe`.
   - Adapter tests against an `AppBridge`, as `runtime.test.ts` does now.
3. **Kit runtime.**
   - `createRuntime(host, …)`, `mount(…, { host })`.
   - `ctx.host`, `ctx.model` (`can` / `deliver`), `ctx.links`.
   - `runtime.test.ts` moves to the test host.
   - The rating example uses `ctx.model.deliver` where it updates context.
4. **Built-in views.**
   - `HostProvider` / `useHost`; `app` → `host` across form, chart, options, sources and management views.
   - The form submits and delivers through the contract.
   - The import rule from §4, as a test.
5. **Harness and docs.**
   - `app-mcp dev` keeps working unchanged (it is an MCP Apps host).
   - README: the `ctx` table gets `host`, `model.can/deliver` and `links`, and drops `app`.
