# GenUI v1 plan

Runtime component registry for MCP Apps: forms and charts with built-in loading patterns, served by genui's end-user MCP and forwarded from a company's MCP server through a thin SDK, managed from Claude/ChatGPT via a registry MCP.

**Status (2026-10-22)**
- Done:
  - **M1:** views (shadcn on Base UI), SDK, demo server, local playground host.
  - **M2:** registry (SQLite, scoped tokens, beta/stable, rollback, theme), SDK registry client, `genui` CLI, example custom component.
  - **M3:** separate registry MCP at `/mcp` with better-auth OAuth (`@better-auth/mcp` + CIMD, GitHub/Google/OIDC/password), role-filtered tools, component manager + theme controller views, invites.
  - **One runtime (2026-10-23):** the genui runtime lives only in the registry's end-user MCP (`/w/<workspace>/mcp`). `@genui/sdk` and the Python `genui-sdk` are thin adapters: they mirror genui's tools onto the company's server and forward calls with a server token. This replaced the Python port of the runtime.
  - **SDK refresh (2026-10-24):** the SDKs no longer re-list genui's tools every 30 s. Every change to what an environment serves (publish, theme, recipes; from the API, CLI or registry MCP) bumps its revision. The SDK checks it in the background at most once a minute while genui's tools are used, never delaying the host, and re-lists only when it changed. An environment can also have a refresh URL (`genui env set <env> --refresh-url`): the company's server mounts the SDK's refresh endpoint there and the registry calls it on every change. Only the registry calls out; the end-user MCP never does.
  - **Environments (2026-10-24):** beta/stable, promote and rollback are gone. Workspaces define environments (`prod` plus their own); each serves what was last published or saved to it, at its own end-user MCP URL, with suffixed tool names outside prod. See [ENVIRONMENTS-PLAN.md](ENVIRONMENTS-PLAN.md).
- Next:
  - **M0 spike:** real-host test via a tunnel.
  - **M4:** packaging (Docker, self-host docs).
- Deviations from the plan below:
  - SQLite through the built-in `node:sqlite` instead of Drizzle: no native dependencies, with all SQL kept in one store module.
  - Custom components declare the tools they call in their manifest, for typing and local mocks.
  - No tool allowlist (`allowTools`): see "Tool access" below.

---

## 1. Decisions

| Area | Decision | Notes |
|---|---|---|
| MCP base | **`mcp-use` (TypeScript)** for *our* servers (registry MCP, demo server) | `use-mcp` is a different project: an archived React client hook (archived 2026-02-06). `mcp-use` is the MIT server framework with React views for MCP Apps, built on the official TS SDK. |
| SDK dependency | SDK depends only on the **official TS SDK** (server + client) | The SDK runs inside *customers'* servers; depending on `mcp-use` would force them onto it. It holds no genui logic, only forwarding, so adapters for other languages and frameworks stay small. |
| Inputs | **shadcn/ui** (Base UI + Tailwind; React code running on Preact via `@preact/compat`) | Theme via CSS variables: host `styles.variables` → shadcn tokens → workspace overrides. |
| Charts | **shadcn charts (Recharts, MIT)** | Same theming system as the inputs; chart palette = shadcn `--chart-1..N` vars. Chart types v1: line, bar (incl. horizontal/stacked), area, pie/donut. Highcharts dropped (commercial licence, see §7). |
| Database | **SQLite** (WAL mode) via Drizzle | Single instance is fine for v1 and self-host. Keep queries portable for Postgres/libSQL when cloud needs multiple instances. Bundles stored as BLOBs. |
| Bundles | One **single-file HTML** per view (Vite + singlefile plugin), JS/CSS inlined | Default host CSP allows inline scripts/styles but no eval and no undeclared external scripts. Inlining works in every host. |
| Dashboards | **None.** `render_chart` only | |
| Custom components | **CI flow only** (`genui publish`) | Git sync, PR previews later. |

---

## 2. Packages (monorepo)

```
packages/
  format/     zod schemas: form spec, chart spec, component manifest, theme tokens
  ui/         views (shadcn + charts; React code on Preact) + loading patterns + view runtime (ext-apps useApp)
              → builds dist/form.html, dist/chart.html (single-file)
  sdk/        connectGenUI + mountGenUI(server, { genui }): mirrors genui's tools, ui:// resources and prompts, forwards calls
  sdk-python/ the same adapter for Python MCP servers
  cli/        genui publish / genui login
apps/
  registry/   HTTP API + registry MCP (management tools + theme controller view) + end-user MCP (the genui runtime) + SQLite
  demo/       example "customer" MCP server (mcp-use) with mock tools, using the SDK
```

---

## 3. Built-in tools (served by genui's end-user MCP, forwarded by the SDK from the customer's server)

### `render_form` (model-visible)

The model builds the form spec; the view renders it.

```jsonc
{
  "title": "New order",
  "fields": [
    { "name": "customer", "type": "resource_select", "label": "Customer", "required": true,
      "source": {
        "toolName": "search_customers",
        "params": { "region": "EU" },        // filled by the AI (required tool params)
        "searchParam": "query",              // param the select writes the typed text into
        "itemsPath": "items",                // where the array lives in structuredContent
        "idPath": "id",
        "labelPath": "name"
      } },
    { "name": "products", "type": "resource_multiselect", "label": "Products",
      "source": { "toolName": "list_products", "searchParam": "q",
                  "itemsPath": "data.products", "idPath": "sku", "labelPath": "title" } },
    { "name": "priority", "type": "select", "options": [{ "id": "low", "label": "Low" }, { "id": "high", "label": "High" }] },
    { "name": "notes", "type": "textarea" }
  ],
  "submit": { "toolName": "create_order", "params": { "channel": "chat" }, "label": "Create order" }
}
```

- **Field types v1:** text, textarea, number, email, date, checkbox, switch, radio, select, multiselect, resource_select, resource_multiselect.
- **Added `itemsPath`** to your source spec: tools rarely return a bare array.
- **Later:** `dependsOn` (dependent selects), pagination cursor.
- **Submit validation:** the submit tool returns, in `structuredContent`:

  ```ts
  type SubmitResult =
    | { ok: true; message?: string; result?: unknown }
    | { ok: false; fieldErrors?: Record<string, string>; formError?: string };
  ```

  - On `ok: false`, show the errors inline and keep the values.
  - On `ok: true`, call `updateModelContext` with a summary of the submitted values and the result, so the model knows what happened. Optionally follow with `sendMessage`.

### `render_chart` (model-visible)

One tool, three ways to pass data. **The same mapping (`x`, `series`) applies to every mode,** so the model learns one shape.

```jsonc
// 1. Inline rows: the AI passes data it already has (from another tool, a file, the conversation)
{ "type": "line", "title": "Signups",
  "data": { "rows": [ { "week": "W1", "signups": 120, "churn": 8 }, { "week": "W2", "signups": 140, "churn": 11 } ] },
  "x": "week",
  "series": [ { "path": "signups", "name": "Signups" }, { "path": "churn", "name": "Churn" } ] }

// 2. Inline series: chart-native shape, handy for small hand-built charts
{ "type": "pie", "title": "Plan mix",
  "data": { "categories": ["Free", "Pro", "Team"], "series": [ { "name": "Accounts", "values": [620, 210, 70] } ] } }

// 3. Source: the view fetches the data itself via an app→server tool call
{ "type": "bar", "title": "Revenue by month",
  "data": { "source": { "toolName": "get_revenue", "params": { "year": 2026 }, "itemsPath": "rows" } },
  "x": "month",
  "series": [ { "path": "revenue", "name": "Revenue" } ],
  "refreshSeconds": 60 }
```

| Mode | Use when | Notes |
|---|---|---|
| Inline rows | Data is already in the conversation, small to medium | Streams in: `ontoolinputpartial` draws points as rows arrive. Every row costs model output tokens. |
| Inline series | Tiny, hand-built charts | No mapping needed |
| Source | Large or live data, or data the model shouldn't see | Data never enters model context. Optional polling (`refreshSeconds`), paused offscreen. Requires the SDK in the customer's server. |

- Guidance in the tool description: "use `source` above ~200 rows or when data must stay fresh".
- Optional `format` per series (number/currency/percent, unit) and `stacked` / `horizontal` flags.

### Tool access

genui is a runtime UI registry, not a permissions layer or a release manager. Views may call any tool the server exposes to apps. Which calls run is left to the host (`visibility`, its approval settings) and to the server's own auth. Registry previews flag their results (`genui/preview`), so views render there without calling tools.

### Loading patterns built into the views

1. **Skeleton from streaming input.** `ontoolinputpartial` renders the fields while the model is still writing the spec. Partial JSON is for preview only.
2. **Search-as-you-type** with debounce, minimum characters, and cancelling stale requests.
3. **Initial options** load without search (first page). Selected values stay cached.
4. **Submit state:** pending, then inline errors or success, with no double submit.
5. **Chart refresh:** stale-while-revalidate plus polling that pauses offscreen.
6. **Graceful errors:** inline retry, and `updateModelContext` reports the failure to the model.

---

## 4. `ui://` feasibility: verified against the MCP Apps spec

| Question | Spec says | Implication |
|---|---|---|
| Can the SDK register `ui://` resources dynamically? | Content comes from `resources/read`. `_meta.ui` (CSP etc.) may be set per read. | **Yes.** genui's end-user MCP serves bundle HTML; the SDK caches it by URI. |
| Do hosts cache? | "Host MAY prefetch and cache UI resource content." | **Never change content behind a URI.** Use content-hashed URIs: `ui://genui/form/<hash>`. |
| How does a new version reach tools? | The tool's `_meta.ui.resourceUri` points at the resource. Tool changes are signalled via `notifications/tools/list_changed`. | On a publish to the environment, genui repoints `resourceUri`; the SDK re-lists and emits `list_changed`. Hosts that don't refresh mid-session pick it up in the next conversation. |
| Old messages? | The host re-renders old tool results from their stored URI. | **Keep previous versions resolvable.** Immutable retention, never delete recent hashes. |
| View calling tools (options, submit)? | App→server `tools/call` works for tools whose `visibility` includes `"app"`, **on the same server connection only**. | This confirms the architecture: `resource_select` and `render_chart` with a source need the SDK inside the customer's server. A hosted trial MCP can do static forms and charts only. |
| App-only tools | `visibility: ["app"]` hides the tool from the model; the host rejects app calls to tools without `"app"`. | Use it for internal view helpers and for admin actions (theme and recipe saves). The default `["model","app"]` covers customers' existing tools. |
| CSP | Default: `script-src 'self' 'unsafe-inline'`, no eval, `connect-src 'none'`. | Use single-file inline bundles. Never load code at runtime via eval. |
| Theming | `HostContext.styles.variables` has standard vars (`--color-background-primary`, `--color-text-primary`, …). | Map them to shadcn tokens, then apply workspace overrides on top. |
| Display modes | inline / fullscreen / pip, negotiated per host. | The theme controller requests fullscreen where available. |
| Model context | `updateModelContext`, `sendMessage`. | Use after submit and on errors. |

**Not in the spec, so test per host in the M0 spike:**
- whether Claude and ChatGPT refresh tools on `list_changed` mid-session;
- how long they cache resources;
- whether the tool result's `_meta` reaches the view (the plan is to deliver theme tokens there, see §5);
- whether ChatGPT honours `_meta.ui.visibility`;
- whether fullscreen is available in each host.

---

## 5. Management (registry MCP, Claude/ChatGPT first)

### Theme controller (view, fullscreen where available)

- **Tokens v1:** primary + foreground, accent, radius, density, chart palette (6–8 colours), each in light and dark variants.
- **Default inherits host variables.** Overrides stay within host guidelines. ChatGPT: brand colour on accents and primary buttons only, system fonts. Claude: host tokens for structure.
- **Flow:** draft → live preview with sample form and chart → publish. Publish is an app-only button.
- **Delivery:** genui's end-user MCP attaches current theme tokens to each `render_*` tool result (`_meta.genui.theme`).
  - Theme changes apply on the next render without changing bundle URIs.
  - Verify in the spike that the view receives the result's `_meta`. Fallback: an app-only `genui_theme` tool called on view init.

### Tools

- **Model-visible:** `manage_components` (the version each environment serves), `use_environment` (what this person's previews, theme and recipes show), `open_theme_controller`, `manage_recipes`, `draft_recipe`, `preview_*`.
- **App-only** (human click inside the view): `theme_save`, `recipe_save`, `recipe_delete`, each for one environment.
- **Roles:**
  - members: browse, preview, switch their active environment;
  - admins: also save themes and recipes. Publishing is CI's job (publish tokens).

### Auth

- Registry MCP uses OAuth with GitHub or Google as the identity provider, implemented with an off-the-shelf MCP auth server library (e.g. better-auth for self-host, WorkOS AuthKit for cloud). No web UI of ours beyond the identity provider's pages.
- SDK → genui's end-user MCP: workspace server token (`genui token server <name>`), sent as a bearer token. The URL picks the environment.

---

## 6. Custom components (CI)

```yaml
# .github/workflows/genui.yml
- run: npx genui publish --env staging
  env: { GENUI_TOKEN: ${{ secrets.GENUI_TOKEN }} }   # publish token limited to staging
```

- **Manifest:** name, version, props schema, sources used, supported hosts, CSP domains.
- **Build output:** a single-file HTML.
- **Publish checks:**
  - manifest schema;
  - versions are immutable (a breaking props change is a warning);
  - size limit;
  - declared CSP domains.
- **Registration:** genui's end-user MCP serves each custom component as a model-visible `render_<name>` tool plus its `ui://` resource; the SDK mirrors both onto the customer's server.
- **Environments:** CI publishes to an environment (`--env`); `genui publish <name>@<version> --env prod` serves an existing version elsewhere without rebuilding. No promotion step.

---

## 7. Resolved: charting library

**Decision: shadcn charts (Recharts, MIT).** Highcharts was dropped because it is commercial. Distributing it inside a product needs an OEM licence, which would force every commercial user of the SDK to license it.

- The theme controller's chart palette maps directly to shadcn's `--chart-1..N` CSS variables, so charts and inputs share one theming system.
- If a customer ever needs Highcharts, it can come later as an optional adapter where they bring their own licence.

---

## 8. Milestones (~6–7 weeks)

| # | Scope | Time |
|---|---|---|
| **M0 Spike** | Hello-world in Claude + ChatGPT. Hashed `ui://` URIs, `list_changed` behaviour, result `_meta` reaching the view, app→server calls, fullscreen, host vars. | 1 wk |
| **M1 Views** | Format schemas; `render_form` (all field types, resource selects, submit validation); `render_chart` (static + source); loading patterns; host theming. | 2 wks |
| **M2 SDK + registry** | SQLite registry, bundles, channels, SDK mount/cache/fallback, demo server. | 2 wks |
| **M3 Management + CI** | Registry MCP with OAuth and roles; theme controller; component list/promote/rollback; `genui publish`. | 1–2 wks |
| **M4 Packaging** | Docker image (container + SQLite volume), self-host docs incl. MCP tunnels for Claude/ChatGPT, licences (MIT SDK/UI/format, FSL registry), examples. | 1 wk |

---

## 9. Out of v1

- Copilot / Gemini (A2UI)
- `dependsOn` and pagination for selects
- Git sync, PR previews, per-consumer version pinning
- Multiple component sources with trust levels
- SSO, billing, analytics
- AI component builder beyond a Claude Code skill
