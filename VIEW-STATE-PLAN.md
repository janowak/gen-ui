# View state plan

A re-rendered view (scroll back, reload, reopen the chat) comes back as the user left it. The kit gives every view `useState<T>`-style state: a value and a setter. Underneath, it finds the render id and calls the right storage: the host's own state where it has one (ChatGPT `widgetState`), `localStorage` elsewhere, memory as a last resort. The built-in form builds its draft and submit state on top of it. genui stores no view state, now or later. Implements [janowak/gen-ui#1](https://github.com/janowak/gen-ui/issues/1).

**Status (2026-10-24)**
- Built (phases 1–7, 2026-10-24). The guarantees in §7 are published only after the M0 checks in §8.
- Next: HOST-ADAPTER-PLAN.md puts every view–host interaction behind one contract. The backends in §4 become the MCP Apps adapter's `host.state`.
- Extends issue #1 with:
  - a generic `useState`-style hook in the kit (§3);
  - the backend adapter underneath it (§4);
  - the form's draft and submit shape on top (§5);
  - an idempotency key (§6, phase 5).

**Principle: the host keeps the id, the browser or host keeps the state, the customer's server keeps the truth.** genui mints a render id and forgets it. Drafts and "done" live in the host or the browser. Anything that must hold (answered once, across devices) is enforced by the customer's own submit tool, keyed by that id.

---

## 1. What changes

| | Today | After |
|---|---|---|
| Render id | `_meta["genui/viewId"]` only | `structuredContent.genui.id`. The `_meta` copy stays only until M0 check 1 shows which one hosts replay; then one goes |
| State API | Kit only: `ctx.state.get()` / `set()` | `useState<T>` mechanics for every view: `ctx.useState(initial)` in the kit, `useViewState(initial)` for React views. No ids or storage in component code |
| Storage | `localStorage`, else memory | Picked per host: ChatGPT `widgetState` (`privateContent`), `localStorage`, memory, or a custom backend |
| Built-in form | Values and "Submitted" in React state. A replay is blank and can be submitted again | Draft and submit state, as the form's own shape in `useViewState`. A replay restores the draft, shows a submitted form as done, and says when a submit was interrupted |
| Answered once | Not enforced | Best effort in the view. Enforced only where the customer's submit tool uses the render id (§6) |

**Unchanged:** no server-side state, no new tables.

**No legacy support.** We're in development: today's kit API, saved entries and render results are replaced outright, with no fallbacks or migrations.

---

## 2. Layers

```
@app-mcp/kit/state            one store per view: attached to the App, finds the id, picks the backend
 ├─ ctx.useState<T>()       custom components (@app-mcp/kit, no framework)
 └─ useViewState<T>()       React views (@app-mcp/kit/react): the built-in form, React components
     └─ form                useViewState<SavedForm>(): adds { values, submit } and the submit transitions
```

- **The store never looks inside the value.** Everything about drafts and submits lives with the form.
- **The form's shape uses only the public hook.** If a second component needs the same submit flow, it moves into the kit as an optional helper, unchanged.
- **Custom components get the generic state only.** They model their own "done" with it, as the rating example does.

---

## 3. The hook (kit)

```ts
// React views (@app-mcp/kit/react)
const [value, setValue, saved] = useViewState<T>(initial, key?);

// Custom components (@app-mcp/kit): called in render, which runs on every change
const [value, setValue, saved] = ctx.useState<T>(initial, key?);

value     // the restored value, else `initial`
setValue  // T | ((prev: T) => T). Re-renders now; the write is debounced
saved     // { restored: boolean; persistence: "host" | "browser" | "memory"; flush(): Promise<void> }
```

- **Same mechanics as `useState`.** The value starts as `initial` and switches to the restored value once it's loaded. If the user changed it first, their value wins and is saved.
- **`saved.restored`:** false until loaded. Loading is instant on ChatGPT and comes with the render result elsewhere. Use it to show a skeleton instead of a flash of defaults.
- **`saved.persistence`:** "host" (stored with the message by the host), "browser" (this browser only), "memory" (this view only). Lets a component say "Saved on this device".
- **`saved.flush()`:** writes now. Await it before a side effect that must not repeat (a submit).
- **`key`:** for more than one independent state in a view. Default `"state"`; calls with the same key share one value.
- **No schema.** A restored value was written by the same bundle, because `ui://` URIs are content-hashed and old messages render the code they were made with. The type parameter is enough.
- **`ctx.viewId`** stays on the kit context: the render id, to pass to submit tools as an idempotency key (§6).

**How it finds the id:** `attachViewState(app, scope)` runs once per iframe, when the `App` is created and before it connects. The kit's `createRuntime` and the UI's `useView` (`onAppCreated`) call it; component code never does.
- It listens with `app.addEventListener("toolresult")`.
- It has to attach that early because the host sends the tool result once, so a listener added after `connect` misses it.
- One view per iframe, so the hooks read a single store per page.

---

## 4. The adapter

```ts
interface Saved { values: Record<string, unknown>; at: number }   // by hook key; `at`: last write, for the sweep

interface StateBackend {
  readonly persistence: "host" | "browser" | "memory";
  /** Needs the render id. Host state is already scoped to the message, so it doesn't wait for one. */
  readonly keyed: boolean;
  load(key: string): Saved | undefined | Promise<Saved | undefined>;
  save(key: string, saved: Saved): void | Promise<void>;
}
```

**Picked in this order:**

1. `attachViewState(app, scope, { backend })`: a custom backend. The extension point for a customer who wants state on their own server (app-only `get_draft` / `save_draft` tools on *their* MCP). genui ships none.
2. **ChatGPT:** `typeof window.openai?.setWidgetState === "function"`.
   - Reads `window.openai.widgetState?.privateContent?.genui`.
   - Writes `setWidgetState({ ...current, privateContent: { ...current.privateContent, genui: saved } })`. It merges, because `setWidgetState` replaces the whole state and a component may use `window.openai` itself.
   - `privateContent`, not top-level state: plain widget state goes to the model on the next turn.
   - Available at load, so ChatGPT restores before any tool result arrives.
3. **Browser:** `localStorage` under `genui:<scope>:<id>`, if a probe write succeeds. Waits for the render id. Scope is the component name, or `form` for the built-in form.
4. **Memory.**

**Writes:**
- Debounced (~300 ms) after a `setValue`.
- `flush()` writes at once and resolves when the backend has it.
- Pending writes are flushed on `pagehide` and when the page is hidden, and in `onteardown` where the kit runtime or `useView` owns it. Hosts may drop the iframe without tearing it down.

**Sweep:** on the first browser load per page, delete `genui:*` entries whose `at` is over 30 days old. Best effort: it only runs when a genui view opens in that origin again.

**Size:** cap a saved entry (and warn in `genui dev`) instead of failing silently. ChatGPT documents no limit for widget state, and a large draft costs every replay.

**Where the code lives:**
- `packages/kit/src/state.ts`, exported as `@app-mcp/kit/state`.
- The hook in `packages/kit/src/react.ts`, exported as `@app-mcp/kit/react`, with `react` as an optional peer dependency. `@app-mcp/ui` aliases it to Preact as it does today.
- `@app-mcp/ui` depends on `@app-mcp/kit` for these two modules only. One implementation for built-in views and custom components.

---

## 5. The form's shape (`packages/ui`)

`packages/ui/src/views/form/saved.ts` holds the form's shape and its transitions as pure functions over the value of `useViewState<SavedForm>({})`:

```ts
interface SavedForm {
  values?: FormState;   // the draft; dropped once done
  submit?: { status: "pending" | "done"; by: string; message?: string; at: number };
}
type SubmitStatus = "open" | "pending" | "done" | "interrupted";
```

- **`by`** is a random id per view instance. A `pending` written by another instance means that view closed mid-submit, so it reads as `interrupted`: the submit may or may not have gone through.
- **`begin`:** `setSaved(begin)` and `await flush()`, before the tool call.
- **`finish`:** done with the message, values dropped, `await flush()`. Only the message stays, so less personal data is kept.
- **`fail`:** back to open, values kept.
- **`restoreValues(fields, saved)`:** `initialState(fields)` overlaid with the saved values for known field names.

`FormView` uses them, so `render_form` and `use_recipe` forms both get this:

- **Mount:** fields from `restoreValues`. A restored draft beats the model's prefill. If the user typed before the restore, their edits win (the hook's rule).
- **Change:** saves the values. Validation errors and `formError` aren't saved.
- **Submit:** `begin`, then today's tool call. Field errors from the submit tool → `fail` and show them. Success → `finish`, then delivery to the model (`updateModelContext` / `sendMessage`), as today.
- **Replay `done`:** the done card with the saved message. Nothing is sent to the model again.
- **Replay `interrupted`:** the form, read-only, with "We couldn't confirm this was sent." and a **Send again** button. Send again reuses the same render id, so an idempotent submit tool dedupes it.

---

## 6. Idempotency key (recommended, phase 5)

"Answered once" can't hold in the view alone (another device, cleared storage, an interrupted submit). The customer's tool can make it hold, keyed by the render id, with no genui storage:

- **`FormSpec.submit.idempotencyParam?: string`:** the submit tool parameter that receives the render id. Recipe authors set it in the recipe. The `render_form` description tells the model to set it when the submit tool has such a parameter.
- **Recipe webhooks:** the form sends the id to `genui_validate`, and the webhook body carries `viewId`, so webhooks can dedupe too.
- **Kit:** the docs show `ctx.tools.call(name, { ..., request_id: ctx.viewId })`.

---

## 7. Guarantees (README, after M0)

| | ChatGPT (`widgetState`) | Claude and other MCP Apps hosts (`localStorage`) | No storage (opaque sandbox, blocked) |
|---|---|---|---|
| State survives a re-render | ✓ (if M0 confirms) | ✓ same browser | ✗ |
| State on another device | ✓ (if M0 confirms) | ✗ | ✗ |
| Submitted form replays as done | ✓ (if M0 confirms) | ✓ same browser | ✗ |
| Answered once | Only with an idempotent submit tool (§6) | Only with an idempotent submit tool (§6) | Only with an idempotent submit tool (§6) |
| Kept for | As long as ChatGPT keeps the message | Up to ~30 days, best effort; the browser can drop it sooner (private windows, Safari limits, cleared data) | The view's lifetime |

---

## 8. M0 checks (before publishing §7)

1. **Replay:** do Claude and ChatGPT replay both `_meta` and `structuredContent` to a re-rendered view, with the same id after a reload?
2. **Model visibility:** does each host show the model `structuredContent`, `content`, or both? If a host shows only `structuredContent`, the model loses the "Showing form… you receive the values in context" text. Then either move the id back to `_meta` only, or repeat the text in `structuredContent`.
3. **ChatGPT:** is `window.openai.setWidgetState` present in MCP Apps (`ui://`, ext-apps bridge) iframes? Does the state survive a reload and show up on another device? Does `privateContent` stay out of the model's context?
4. **Sandbox origin per host:** per conversation, per server URL or per hostname? This decides whether `localStorage` persists at all, and whether two workspaces on the hosted end-user MCP share an origin (§9, gap 5).
5. **Storage lifetime:** does `localStorage` in Claude's sandbox survive a reload in Chrome, Safari and Firefox?

---

## 9. Gaps and risks

1. **"No customer data on our side" holds for state, not for traffic.** genui stores no view state. But with the cloud runtime, the arguments the model passes to render tools (specs, prefills, inline rows) still pass through genui, and recipe values pass through on their way to the webhook. That doesn't change here. Self-hosting remains the answer for those.
2. **Answered once is not guaranteed** without §6. On Claude, another browser or cleared storage shows the form open again.
3. **Interrupted submits.** If the view closes after the tool call but before "done" is saved, the replay can't know the outcome. The form shows `interrupted`, and a retry is safe only with §6.
4. **The id becomes model-visible.** `structuredContent` goes to the model in most hosts: a few tokens of noise, and the possible content-vs-structuredContent problem in M0 check 2.
5. **Shared origins.** A host that derives the sandbox origin from the hostname (the spec's example `www-example-com.oaiusercontent.com`) puts every workspace of genui's hosted end-user MCP in one origin. There, a tenant's custom component could read another tenant's `localStorage` state. ChatGPT avoids this by using `widgetState`. Behind a customer's SDK, the origin is the customer's server. If M0 finds a hostname-scoped host without host state, give the hosted MCP per-workspace hostnames or set `_meta.ui.domain` per workspace.
6. **Drafts at rest.** Plaintext in the browser until the sweep, and in ChatGPT's message storage. Add `FormSpec.persistDraft: false` for sensitive forms: they keep only the submit state.
7. **Two live views of one render** (the same chat in two tabs, inline plus fullscreen): last write wins. Not handled.
8. **The sweep is best effort.** It only runs when a genui view opens in that origin again. Don't promise deletion after 30 days.
9. **The spec may add host state.** MCP Apps lists "state persistence and restoration" as future work. When it lands, it becomes another backend in §4; components don't change.

---

## 10. Steps

1. **Render id in `structuredContent`.**
   - `apps/registry/src/runtime.ts` (`meta()` → also `structuredContent: { genui: { id } }`) and the previews in `apps/registry/src/mcp.ts`.
   - `VIEW_CONTENT_KEY = "genui"` in `packages/format/src/meta.ts`.
   - Tests: registry runtime and management tests; `packages/sdk/src/mount.test.ts`; Python `test_mount.py`, which checks that `structured_output=False` still forwards `structuredContent`.
2. **Store and adapter** in `packages/kit/src/state.ts` (`@app-mcp/kit/state`):
   - `attachViewState(app, scope, options)`: the id from `structuredContent` (and `_meta` until M0 check 1 picks one), backend selection, values by hook key.
   - Debounced writes, `flush`, flush on `pagehide` and teardown, the sweep, the size cap.
   - Unit tests with a fake `window.openai`, a fake `Storage` and an `AppBridge`.
3. **Hooks.**
   - `ctx.useState` and `ctx.viewId` in `packages/kit/src/runtime.ts`; `createRuntime` attaches the store. `ctx.state` goes.
   - `useViewState` in `packages/kit/src/react.ts` (`@app-mcp/kit/react`) on `useSyncExternalStore`.
   - Tests:
     - restore before the id on ChatGPT, after it in the browser;
     - the user's value beats a later restore;
     - two keys stay independent;
     - `flush` before a tool call.
   - The rating example moves to `ctx.useState` and passes `ctx.viewId`.
4. **Built-in form.**
   - `useView` attaches the store in `onAppCreated`.
   - `saved.ts`: the shape, the transitions and `restoreValues`, with tests.
   - `FormView` changes (§5).
5. **Idempotency key** (§6):
   - `idempotencyParam` in `FormSpec` (format).
   - Form and `genui_validate` pass the id; the webhook body adds `viewId`.
   - Tool descriptions.
6. **`genui dev`.**
   - `renderResult()` sends `structuredContent`.
   - A "Host state" setting: browser, ChatGPT (a `window.openai` shim the dev page injects, kept by the harness per view id so **Replay** restores), none.
   - Saved state in the log on each write, and a "Clear saved state" button.
7. **Docs.**
   - README: the `state` row becomes `useState` / `useViewState` and `viewId`, plus the §7 table.
   - Close #1 with a link to this plan.

---

## 11. Out of scope

- Server-side state in genui. If a customer needs state across devices on Claude, they plug a custom backend (§4) into their own tools.
- A submit helper in the kit. It moves there from the form when a second component needs it.
- Syncing two live views of one render.
- State for the chart and management views.
