# Custom chat plan

Render app-mcp components in a company's own chat: their frontend, their backend, their LLM calls. The backend gets app-mcp's tools for its LLM requests and runs them through `@app-mcp/sdk`, server to server. The frontend renders the result as a web component with a shadow root ("light render") instead of an MCP Apps iframe. The company supplies what an MCP Apps host would (tool calls, messages, model context, theme, state) through the host adapter contract from HOST-ADAPTER-PLAN.md.

**Status (2026-10-26)**
- Proposed. Needs HOST-ADAPTER-PLAN steps 1–4 first: this is the contract's second implementation.
- Decided:
  - Each module defines its own custom element (`<app-mcp-rating>`).
  - One version of a component per page. Two versions on one page aren't supported; the second one fails with a clear error.
  - A React wrapper, `<AppMcpView>`.
  - A CSS rewrite plugin for shadow roots.
  - Portals render into the shadow root.

**Principle: one publish, two renderers.** A component keeps one definition, one manifest and one `render_<name>` tool. Each version gets a second build output, the light module, next to the single-file HTML. Claude and ChatGPT keep the iframe; a custom chat loads the module. The model sees the same tools either way.

---

## 1. The flow

```
Browser (company chat UI)           Company backend                         app-mcp
─────────────────────────           ───────────────                         ─────
                                    harness.tools("anthropic")              (SDK memory)
                                    LLM streams tool_use render_rating
◄── start { tool, module }          harness.module("render_rating")
import /app-mcp/modules/<hash>.js ──► GET: from SDK memory ─── once ────────► app-mcp://module/<hash>
◄── partial JSON                    input_json_delta
                                    harness.execute(name, args) ──────────► tools/call
◄── render { args, result }         forModel → tool_result → LLM
view: tools.call("save_rating") ──► POST /app-mcp/call → the company's tools
view: model.update / model.send ──► the company's chat state → next LLM request
```

- How the backend streams to its browser (SSE, websockets, the Vercel AI SDK's message parts) stays the company's. app-mcp defines only what travels: the module, the input and the render result.
- The module's hash is known when `tool_use` starts, so the browser loads the module while the arguments stream.
- Browsers never talk to app-mcp. Modules come from the company's backend, so its CSP needs nothing new (`script-src 'self'`).

---

## 2. Server: harness helpers in `@app-mcp/sdk`

Built on `connectAppMcp`, which already keeps app-mcp's tools in memory, forwards calls and fetches content-hashed resources once.

```ts
import { connectAppMcp, appMcpHarness } from "@app-mcp/sdk";

const appMcp = connectAppMcp({ url: process.env.APP_MCP_MCP_URL, token: SERVER_TOKEN });
const harness = appMcpHarness(appMcp); // also prefetches the modules of the current tools

// Behind your own auth: modules, and tool calls from views.
app.all("/app-mcp/*", (c) => harness.handler({ callTool: (name, args, request) => myTools.call(name, args, request) })(c.req.raw));

// A chat turn (Anthropic shown).
const stream = anthropic.messages.stream({
  model,
  system: [mySystem, harness.instructions()].filter(Boolean).join("\n\n"),
  tools: [...myToolDefinitions, ...harness.tools("anthropic")],
  messages,
});
// tool_use starts and harness.owns(name): send { id, tool: name, module: harness.module(name) } to the browser.
// input_json_delta: forward the partial JSON.
// tool_use complete:
const { forModel, render } = await harness.execute(block.name, block.input);
// forModel → the tool_result. render → stored with the message and sent to the browser.
```

| Method | What |
|---|---|
| `tools(format)` | app-mcp's model-visible tools, answered from memory. Formats:<br>• `"anthropic"`: `{ name, description, input_schema }`.<br>• `"openai"`: function tools, non-strict, because the form and chart schemas use unions that strict mode rejects.<br>• `"mcp"`: raw MCP `Tool`s, e.g. for the Vercel AI SDK's `jsonSchema`.<br>Leaves out app-only tools (`_meta.ui.visibility: ["app"]`) and tools without a module, which can't render here. |
| `instructions()` | The environment's instructions, for the system prompt. |
| `owns(name)` | Whether a tool is app-mcp's, model-visible or app-only. Everything else is the company's. |
| `module(name)` | `{ tag, hash }` of the module a tool renders with. |
| `execute(name, args)` | Forwards the call to app-mcp. Returns:<br>• `forModel: { text, isError }`, for the tool result;<br>• `render: { tool, module, args, result }`, with `result` in its MCP shape, untouched. It carries the render id and workspace theme.<br>When app-mcp is down: the SDK's "app-mcp is unavailable right now" error and no `render`. |
| `handler({ callTool, base? })` | `(Request) => Response` under `base` (default `/app-mcp`):<br>• `GET <base>/modules/<hash>.js`: from memory, else fetched once from app-mcp. Any hash, so old messages load the code they were rendered with. `text/javascript`, `Cache-Control: public, max-age=31536000, immutable`.<br>• `POST <base>/call` `{ name, args }`: app-mcp's app-only tools (`app_mcp_validate`) go to app-mcp; the rest go to `callTool`, which gets the `Request` for the company's auth. Plain JSON results are wrapped as `structuredContent`. |

- Modules travel from app-mcp to the SDK as MCP resources (`app-mcp://module/<hash>`, `text/javascript`), over the existing connection and server token.
- Which of its tools `callTool` exposes is the company's call. A component's manifest lists the tools it uses (`tools`).
- app-mcp's tool names are `render_*`, `use_recipe` and `app_mcp_*`. Avoiding clashes with the company's own tool names is the company's job.

---

## 3. Browser: `@app-mcp/element`

What a company installs in its chat frontend: the host for its views, a loader, and the React wrapper. The views' own code comes in the modules.

### React wrapper

```tsx
import { AppMcpView } from "@app-mcp/element/react";

<AppMcpView
  module={part.module}             // { tag, hash } from harness.module() or render.module
  input={part.input}               // partial JSON (text or object) while streaming, then the args
  streaming={part.streaming}
  result={part.render?.result}     // from harness.execute
  cancelled={part.cancelled}
  theme={theme}                    // "light" | "dark"
  host={{ sendMessage, updateModelContext, openLink, state }}
  base="/app-mcp"                    // default; module URLs and the default callTool
/>
```

- Loads the module, renders its element, and turns prop changes into host events (`input-partial`, `input`, `result`, `cancelled`, `context`).
- Re-rendering an old message is the same component with the stored `args` and `result` and no streaming. Saved state comes back by render id.
- A module that fails to load (a version conflict, the backend unreachable) renders the error in its place.

### Host

```ts
import { createHost, load } from "@app-mcp/element";

const host = createHost({ sendMessage, updateModelContext });
await load({ tag: "app-mcp-rating", hash }, "/app-mcp");
const el = Object.assign(document.createElement("app-mcp-rating"), { host });
container.append(el);

host.partial(jsonText);    // while the model streams
host.input(args);          // the complete args
host.result(result);       // MCP CallToolResult from harness.execute
host.cancel();             // the turn was stopped or the call failed
host.setContext({ theme: "dark" });
```

The providers, the "contract" a company implements:

| Provider | Required | Default | Notes |
|---|---|---|---|
| `callTool(name, args, { signal })` | no | `POST <base>/call` | Option sources, chart sources, submits. |
| `sendMessage(text)` | yes | | Posts `text` as the user and runs a turn. |
| `updateModelContext(text, { viewId })` | no | `deliver` posts the details as a message instead | Keep the latest text per view id; add it to the next LLM request. |
| `openLink(url)` | no | `window.open(url, "_blank", "noopener")` | |
| `requestDisplayMode(mode)` | no | inline only | |
| `state` | no | `localStorage` (`app-mcp:<component>:<view id>`), else memory | A `StateBackend` on the company's message store gives state across devices. |
| `theme`, `locale`, `styles` | no | light | Changes emit `context`. |

- Capabilities follow from what's provided, so views check them first (HOST-ADAPTER-PLAN §2).
- `partial()` heals incomplete JSON, which an MCP Apps host does for its views. It also takes already-parsed objects, which the Vercel AI SDK streams.
- The host keeps the render id from the result and passes it to `updateModelContext`.
- `contract: HOST_CONTRACT`. A module built against another contract fails with a clear error; no compatibility code.

---

## 4. The light module

### Kit API: views, not pages

Today a component is a page:
- `mount(component, render)` runs at the top level of its script;
- its markup lives in `index.html`;
- it keeps state in module-level variables;
- `mount` writes theme variables to `document.documentElement`;
- `pageViewStore()` holds one store per page.

One iframe per render made that fine. Now one module serves every render on the page, so a component becomes a view with a per-render setup:

```ts
// src/view.ts
import { view } from "@app-mcp/kit";
import rating from "./component";
import "./view.css";

export default view(rating, (root) => {
  root.innerHTML = `<h2 id="question"></h2><div id="stars" role="radiogroup"></div><p id="status"></p>`;
  const questionEl = root.querySelector("#question")!;
  let saving = 0; // per render now, not per page
  return (ctx) => {
    /* today's render(ctx) */
  };
});
```

- `setup(root)` runs once per render and returns `render(ctx)`, or `{ render, destroy }`. `root` is a `<div>` in the iframe's body, or the shadow root.
- The Vite plugin generates both entries from `src/view.ts`, so components no longer have an `index.html`.
- `mount` goes. This replaces `mount(…, { host })` in HOST-ADAPTER-PLAN §4.
- The view store comes from the runtime, one per render. React components get it from a provider: `reactView(component, App)` in `@app-mcp/kit/react` sets it up, and `useViewState` reads it.
- Theme variables, the dark class and host style variables go on the render's root: `<html>` in the iframe, the custom element in light mode (§5).
- `app-mcp init`, `examples/rating` and the kit's test fixture move to `view`.

### What `dist/app-mcp.module.js` is

- One ES module with no imports: Preact where used, the kit runtime, the view and its CSS.
- On import, it defines `app-mcp-<name>` (`app-mcp-rating`; built-ins `app-mcp-form`, `app-mcp-chart`) unless that tag exists:
  - **Same version:** nothing happens; the module was loaded twice.
  - **Another version:** the import throws "app-mcp-rating 1.1.0 is already on this page; 1.2.0 can't render next to it." Unsupported by design.
- Exports `{ tag, name, version, contract }`.
- The element:
  - takes a `host` property (a `AppMcpHost`);
  - **when connected:** attaches an open shadow root, adopts the module's stylesheet, adds the document CSS (§5) to `<head>` once (`<style data-app-mcp="rating">`), sets the dark class from `host.context()`, and runs `setup`. The stylesheet is built once and shared by all instances.
  - **when disconnected:** tears down: aborts calls and saves state.

### Build

The `appMcp()` plugin writes a second output in the same `vite build`:
- A generated entry, ES format, one chunk (`inlineDynamicImports`), `cssCodeSplit: false`, assets inlined.
- **CSS:** in `generateBundle`, all emitted CSS is collected and run through the rewrite (§5). Its two outputs replace the placeholders `"__APP_MCP_SHADOW_CSS__"` and `"__APP_MCP_DOCUMENT_CSS__"` in the chunk as `JSON.stringify(...)`, and the CSS assets are deleted.
- **Checks,** as for the HTML: exactly one chunk, nothing left over, size within the budget and `MAX_BUNDLE_BYTES`.
- **Manifest:** `app-mcp.component.json` gets `module: "app-mcp.module.js"` next to `bundle`.

---

## 5. CSS rewrite plugin

`shadowCss()` in `@app-mcp/kit/vite`, used by the kit's light build and by `packages/ui`. A PostCSS pass with `postcss-selector-parser` over the collected CSS:

| In | Out | Why |
|---|---|---|
| `:root` | `:host` | shadcn tokens (`styles.css`) and Tailwind's theme variables |
| `html`, `body` | `:host` | Preflight and the `app.css` base styles |
| `.dark` (token block) | `:host(.dark)` | Dark tokens |
| `X:is(.dark *)` (`@custom-variant dark`) | `:host(.dark) X` | `dark:` utilities. From inside the tree, `.dark` on an outside element never matches. |
| `@property` | document CSS | Ignored inside shadow roots. `form.html` has 58 `--tw-*` ones: without them shadows, rings, transforms and some borders break silently. |
| `@font-face` | document CSS | Not reliably loaded from shadow roots |

- **Reset first:** `:host { all: initial; display: block; … }`, plus base font, color and line-height from the host variables. The page's inherited font, color and line-height stop at the boundary. `all` leaves custom properties alone, so a page can still theme from outside.
- **Why `:host`, not a wrapper element:** portals render straight into the shadow root (§6) and need the tokens and dark mode too.
- **Workspace theme** (`--app-mcp-*` from the render result) goes in a second adopted sheet as a `:host` rule, not in inline styles. Page CSS on the element (`app-mcp-rating { --app-mcp-primary: … }`) beats `:host` rules, so a company can override the workspace theme in its own chat.
- **Build check:** after the rewrite, the shadow CSS has no `:root`, `html`, `body`, `@property` or `@font-face`. Otherwise the build warns with the selector and its source (third-party CSS).
- **Tests:** CSS fixtures in and out, plus a check on the built form module.

---

## 6. Built-in views

- `packages/ui` gets light entries next to the HTML ones. `create(root, host)` renders `<HostProvider host><PortalContainer value={root}><FormView /></PortalContainer></HostProvider>` into the shadow root.
- **Portals render into the shadow root.** The shadcn wrappers that portal (`select.tsx`, `combobox.tsx`, `popover.tsx`) pass `container={usePortalContainer()}`: the shadow root in light mode, `undefined` (the document body) in the iframe.
- **One module serves every form on the page.**
  - `pageViewStore()` moves into `HostProvider` (HOST-ADAPTER-PLAN §4).
  - Audit other module-level state under `views/` (option and source loading).
- **Output:** `dist/form.module.js` and `dist/chart.module.js`, from a switch in `vite.config.ts` like today's `INPUT`. `@app-mcp/runtime`'s view bundles carry their JS and hashes.
- **Management views stay iframe-only:** manager, theme, recipes, guide and workspace. They only run in the registry's own connector.

---

## 7. Registry, runtime and CLI

- **Storage:**
  - A new `modules` table, `(workspace_id, hash, js, created_at)`, keyed by workspace and hash.
  - `versions.module_hash` points at it and is empty for versions without a module.
  - The HTML and the module live in separate rows, so each stays under D1's 2 MB.
  - Migration `0005_modules.sql`.
- **Publish:**
  - `POST /v1/components` takes `module` next to `html`. `app-mcp publish` reads it from the manifest's `module`.
  - Re-publishing the same version must match the module hash too.
  - A version without a module (a hand-built bundle) still publishes and works in MCP Apps hosts. Custom chats don't list it.
- **`@app-mcp/format`:** `MODULE_META_KEY = "app-mcp/module"`, and `CatalogComponent.module?: { hash }`.
- **`@app-mcp/runtime` `mountAppMcp`:**
  - `_meta["app-mcp/module"] = { uri: "app-mcp://module/<hash>", tag }` goes on `render_form`, `render_chart`, `use_recipe` (form module) and every component tool with a module.
  - Resource template `app-mcp://module/{hash}` (`text/javascript`). It resolves built-in modules first, then `CatalogSource.module(hash)`: workspace-scoped like `bundle`, any version.
  - `@app-mcp/runtime/local` reads `dist/app-mcp.module.js`, so `app-mcp serve` works behind a local harness.
- **`@app-mcp/sdk`:**
  - `AppMcpClient.module(hash)` reads a module and keeps it in memory. Modules are content-hashed, so there's nothing to invalidate.
  - `appMcpHarness` turns on prefetching the current tools' modules.
  - `mountAppMcp` on a company's MCP server passes `_meta` through as today and doesn't mirror module resources, since MCP Apps hosts don't use them.

---

## 8. Security and limits

- **Shadow DOM isolates styles, not code.** A module runs in the company's page, with its cookies, storage, DOM and credentialed `fetch`. For the workspace's own components and app-mcp's built-ins in the company's own chat, that's the trust the company already gives its own frontend code. The docs say so. Modules are served from the company's backend, pinned by content hash.
- **Hoisted `@property` rules affect the whole page.** They register `--tw-*` page-wide, with the definitions a Tailwind v4 page registers itself. A page on an older Tailwind could see differences.
- **`rem` sizes** follow the page's `html` font size. Left as is for now.
- **Weight:** each module carries its own Preact and kit runtime, so three different components on a page load three copies (the form is ~200 KB gzipped). Sharing the runtime belongs to CDN-BUNDLES-PLAN.
- **Contract versions:** `@app-mcp/element` and the modules ship separately. A `HOST_CONTRACT` mismatch fails with a clear error.

---

## 9. Steps

0. **Host adapter:** HOST-ADAPTER-PLAN steps 1–4.
1. **Kit view API.**
   - `view(component, setup)`, a runtime and store per render, theme on the render's root.
   - The plugin generates the iframe entry from `src/view.ts`.
   - `examples/rating`, `app-mcp init` and the kit fixture move to it.
   - What MCP Apps hosts get doesn't change.
2. **Light build.**
   - Second output, placeholders, element definition and version check.
   - `shadowCss()` with fixture tests.
   - Rating builds both outputs.
3. **`@app-mcp/element`.**
   - `createHost`, partial JSON, `load`, and `<AppMcpView>` in `@app-mcp/element/react`.
   - Tests in Vitest browser mode (Chromium): shadow root, adopted sheets, document CSS added once, the version conflict.
4. **Registry and runtime.**
   - `modules` table, publish API and CLI.
   - `app-mcp/module` meta and `app-mcp://module/{hash}` resources.
   - `app-mcp serve`.
5. **SDK harness.**
   - `appMcpHarness`: `tools`, `instructions`, `owns`, `module`, `execute`, `handler`.
   - Module prefetch.
   - Tests against an in-process registry, like `mount.test.ts`.
6. **Built-in views.**
   - Light entries, `PortalContainer`, the module-level state audit.
   - Form and chart modules in `@app-mcp/runtime`.
   - Check that select, combobox and the date picker open, close and take keyboard input inside a shadow root.
7. **Dev, demo and docs.**
   - `app-mcp dev`: a "Shadow DOM" render mode next to the iframe. Most CSS problems only show there.
   - `apps/chat`, a minimal custom chat and the end-to-end test:
     - Hono backend with the Claude API, `claude-opus-5-5` by default;
     - the demo's mock tools as its own tools;
     - a React frontend with `<AppMcpView>`.
   - README: a "Render in your own chat" section.

---

## 10. Out of scope, follow-ups

- **Version conflicts in the harness.** Detecting two versions of one component in a conversation before rendering, instead of the import error.
- **A harness that is an MCP client of the company's MCP server.** It would need `mountAppMcp` to mirror module resources.
- **Python harness helpers** (`app-mcp-sdk`).
- **A shared runtime across modules**, and serving modules from a CDN.
- **Slash commands in custom chats:** recipe and workflow prompts. `getPrompt` already exists on the client.
- **`rem` normalization.**
- **Light builds of the management views.**
