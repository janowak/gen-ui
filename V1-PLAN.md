# GenUI v1 plan

Runtime component registry for MCP Apps: forms and charts with built-in loading patterns, mounted into a company's MCP server through an SDK, managed from Claude/ChatGPT via a registry MCP.

**Status (2026-10-22)**
- Done:
  - **M1:** views (shadcn on Base UI), SDK, demo server, local playground host.
  - **M2:** registry (SQLite, scoped tokens, beta/stable, rollback, theme), SDK registry client, `genui` CLI, example custom component.
  - **M3:** separate registry MCP at `/mcp` with better-auth OAuth (`@better-auth/mcp` + CIMD, GitHub/Google/OIDC/password), role-filtered tools, component manager + theme controller views, invites.
- Next:
  - **M0 spike:** real-host test via a tunnel.
  - **M4:** packaging (Docker, self-host docs).
  - **M5:** hosted deploy (Hostinger VPS + Cloudflare), including the public MCP. See §9.
- Deviations from the plan below:
  - SQLite through the built-in `node:sqlite` instead of Drizzle: no native dependencies, with all SQL kept in one store module.
  - Custom components declare the tools they call in their manifest, for typing and local mocks.
  - No tool allowlist (`allowTools`): see "Tool access" below.

---

## 1. Decisions

| Area | Decision | Notes |
|---|---|---|
| MCP base | **`mcp-use` (TypeScript)** for *our* servers (registry MCP, demo server) | `use-mcp` is a different project: an archived React client hook (archived 2026-02-06). `mcp-use` is the MIT server framework with React views for MCP Apps, built on the official TS SDK. |
| SDK dependency | SDK depends only on the **official TS SDK + `@modelcontextprotocol/ext-apps/server`** | The SDK runs inside *customers'* servers; depending on `mcp-use` would force them onto it. Add thin adapters for `mcp-use` / others. |
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
  sdk/        mountGenUI(server, opts): registers tools + ui:// resources, caches bundles, resolves channel
  cli/        genui publish / genui login
apps/
  registry/   HTTP API + registry MCP (management tools + theme controller view) + SQLite
  demo/       example "customer" MCP server (mcp-use) with mock tools, using the SDK
```

---

## 3. Built-in tools (mounted by the SDK on the customer's server)

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

genui is a UI registry and release pipeline, not a permissions layer. Views may call any tool the server exposes to apps. Which calls run is left to the host (`visibility`, its approval settings) and to the server's own auth. Registry previews flag their results (`genui/preview`), so views render there without calling tools.

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
| Can the SDK register `ui://` resources dynamically? | Content comes from `resources/read`. `_meta.ui` (CSP etc.) may be set per read. | **Yes.** The SDK serves bundle HTML from its cache. |
| Do hosts cache? | "Host MAY prefetch and cache UI resource content." | **Never change content behind a URI.** Use content-hashed URIs: `ui://genui/form/<hash>`. |
| How does a new version reach tools? | The tool's `_meta.ui.resourceUri` points at the resource. Tool changes are signalled via `notifications/tools/list_changed`. | On promote, the SDK repoints `resourceUri` and emits `list_changed`. Hosts that don't refresh mid-session pick it up in the next conversation. |
| Old messages? | The host re-renders old tool results from their stored URI. | **Keep previous versions resolvable.** Immutable retention, never delete recent hashes. |
| View calling tools (options, submit)? | App→server `tools/call` works for tools whose `visibility` includes `"app"`, **on the same server connection only**. | This confirms the architecture: `resource_select` and `render_chart` with a source need the SDK inside the customer's server. A hosted trial MCP can do static forms and charts only. |
| App-only tools | `visibility: ["app"]` hides the tool from the model; the host rejects app calls to tools without `"app"`. | Use it for internal view helpers and for admin actions (promote/rollback). The default `["model","app"]` covers customers' existing tools. |
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
- **Delivery:** the SDK attaches current theme tokens to each `render_*` tool result (`_meta.genui.theme`).
  - Theme changes apply on the next render without changing bundle URIs.
  - Verify in the spike that the view receives the result's `_meta`. Fallback: an app-only `genui_theme` tool called on view init.

### Tools

- **Model-visible:** `open_theme_controller`, `list_components`, `show_component_versions`.
- **App-only** (human click inside the view): `theme_save_draft`, `theme_publish`, `component_promote`, `component_rollback`.
- **Roles:**
  - members: browse, preview, publish to beta (via CI);
  - admins: also theme publish, promote, rollback.

### Auth

- Registry MCP uses OAuth with GitHub or Google as the identity provider, implemented with an off-the-shelf MCP auth server library (e.g. better-auth for self-host, WorkOS AuthKit for cloud). No web UI of ours beyond the identity provider's pages.
- SDK → registry: workspace server key, set up via `npx genui init` or a one-time enrollment code.

---

## 6. Custom components (CI)

```yaml
# .github/workflows/genui.yml
- run: npx genui publish --channel beta
  env: { GENUI_TOKEN: ${{ secrets.GENUI_TOKEN }} }   # token can publish to beta only
```

- **Manifest:** name, version, props schema, sources used, supported hosts, CSP domains.
- **Build output:** a single-file HTML.
- **Publish checks:**
  - manifest schema;
  - breaking props change requires a major version;
  - size limit;
  - declared CSP domains.
- **Registration:** the SDK registers each custom component as a model-visible `render_<name>` tool plus its `ui://` resource.
- **Promotion:** beta → stable only via the registry MCP (app-only button, admin).

---

## 7. Resolved: charting library

**Decision: shadcn charts (Recharts, MIT).** Highcharts was dropped because it is commercial. Distributing it inside a product needs an OEM licence, which would force every commercial user of the SDK to license it.

- The theme controller's chart palette maps directly to shadcn's `--chart-1..N` CSS variables, so charts and inputs share one theming system.
- If a customer ever needs Highcharts, it can come later as an optional adapter where they bring their own licence.

---

## 8. Milestones (~7–8 weeks)

| # | Scope | Time |
|---|---|---|
| **M0 Spike** | Hello-world in Claude + ChatGPT. Hashed `ui://` URIs, `list_changed` behaviour, result `_meta` reaching the view, app→server calls, fullscreen, host vars. | 1 wk |
| **M1 Views** | Format schemas; `render_form` (all field types, resource selects, submit validation); `render_chart` (static + source); loading patterns; host theming. | 2 wks |
| **M2 SDK + registry** | SQLite registry, bundles, channels, SDK mount/cache/fallback, demo server. | 2 wks |
| **M3 Management + CI** | Registry MCP with OAuth and roles; theme controller; component list/promote/rollback; `genui publish`. | 1–2 wks |
| **M4 Packaging** | Docker image (container + SQLite volume), self-host docs incl. MCP tunnels for Claude/ChatGPT, licences (MIT SDK/UI/format, FSL registry), examples. | 1 wk |
| **M5 Hosted** | Stage 0 of §9: compose with tunnel + Litestream, Cloudflare (Pages, Tunnel, R2, WAF), CI deploy, staging, public MCP on its own hostname without validation webhooks, sign-up hardening. | 1 wk |

---

## 9. Hosting (genui cloud)

The hosted version is the M4 self-host image with `GENUI_MODE=hosted`: one artifact for self-host, cloud and dedicated instances. A Hostinger VPS runs the Node services; Cloudflare sits in front of them and serves the static sites.

### What runs where

| Piece | Runs on | Address |
|---|---|---|
| Landing (`apps/site`), docs | Cloudflare Pages | `<domain>` |
| Playground (`apps/playground`) | Cloudflare Pages | `play.<domain>` |
| Registry: `/v1` API, management MCP `/mcp`, OAuth `/api/auth/*`, sign-in | VPS, `registry` container | `registry.<domain>` (`GENUI_PUBLIC_URL`) |
| Public MCP: `/w/<workspace>/mcp`, `/w/<workspace>/beta/mcp` | VPS, same container for now | `mcp.<domain>` |
| Demo server (`apps/demo`) | VPS, `demo` container | `demo.<domain>/mcp` |
| SQLite backups | Cloudflare R2, via Litestream | |
| SDKs, kit, CLI | npm (`@genui/*`), PyPI (`genui-sdk`) | |

```
Cloudflare: DNS, TLS, WAF, rate limits
├─ <domain>, play.<domain>  → Pages
├─ registry.<domain>        ┐
├─ mcp.<domain>  (^/w/ only)├─ Tunnel → Hostinger VPS (KVM 2, EU), docker compose:
└─ demo.<domain>            ┘           registry · demo · cloudflared · litestream → R2
```

- **VPS, not Hostinger's managed Node.js hosting:** the registry needs a persistent disk for SQLite, Docker and a Litestream sidecar.
- **Cloudflare Tunnel, no open ports** except SSH (keys only). TLS ends at Cloudflare.
- **EU data center:** render calls to the public MCP carry whatever the model puts in them.
- **Cost:** about $10–15/month for the VPS. Cloudflare Free covers Pages, Tunnel and R2 at this size.

### The public MCP puts us on the data path

Without it, the registry is a control plane: customers' servers render from the SDK's last good snapshot, so a registry outage only blocks releases. The public MCP changes that for hosted workspaces:

- Every tool list, render and view load in Claude/ChatGPT is a request to our VPS. Load and uptime now follow end-user usage.
- What the model passes to render calls reaches us: form specs, pre-filled values, inline chart rows. So we are a data processor for those workspaces.

What keeps it simple: **hosted forms have no submit tool and no validation.** Submitted values go back to the conversation through the host and never reach us. So the public MCP:

- only reads the workspace's catalog, recipes and theme;
- makes no outbound calls (no webhooks) and holds no secrets.

That makes it cheap to isolate and easy to move to the edge.

What follows:

- **Own hostname from day one.** Connector URLs pasted into Claude/ChatGPT settings must never change. `mcp.<domain>` lets the public MCP move to its own container, then to the edge, without customers noticing.
  - Needs a `GENUI_HOSTED_URL` setting, so `/v1/hosting` and the manager show full URLs on that host (they return paths today).
  - The tunnel forwards only `^/w/` on that host.
- **Per-request cost.** `hosted.ts` builds a server and reads the catalog from SQLite on every request; only bundles are cached. Fine for the POC. Next step: cache the snapshot per workspace and channel, invalidated by a workspace revision that publish, promote, rollback, theme and recipe saves bump.
- **Drop recipe validation webhooks.** Remove the `validate` path the public MCP uses today: `webhook.ts`, `genui_validate`, the recipe `validate` field and `/v1/hosting/webhook-secret`.
- **Abuse.** The endpoint is unauthenticated: a Cloudflare rate limit per IP on `mcp.<domain>` now, per-workspace request quotas later.
- **Privacy.**
  - No request-body logging: Cloudflare doesn't log bodies by default; strip them on `/w/*` in Sentry.
  - DPA template before the first paying hosted customer.

### Stage 0 setup

1. **Image:** the M4 multi-stage Dockerfile, Node 24 pinned (`node:sqlite` is still experimental). One image for registry and demo, with different commands.
2. **Compose:** `registry` (SQLite on a volume), `demo`, `cloudflared`, `litestream` → R2. Health check on `/health`.
3. **CI:** GitHub Actions builds the image, pushes it to GHCR, then runs `docker compose pull && up -d` over SSH. Staging is a second compose project on the same VPS, with its own database and `*-staging` hostnames.
4. **Cloudflare:**
   - Tunnel ingress per hostname; Pages projects for the site and playground; an R2 bucket for backups.
   - **Bot Fight Mode off** for the zone. Claude's and ChatGPT's backends call `/mcp`, `/.well-known/*` and `/w/*` from datacenter IPs. Challenging them breaks connectors, and on the Free plan Bot Fight Mode can't be skipped per path.
   - No "cache everything" rules on the registry or MCP hostnames.
   - Rate limits on `/api/auth/*`, `/v1/components` and `mcp.<domain>`.
   - Requests idle for 100 s are dropped. Fine for today's request/response MCP; send keepalives if long SSE streams are added.
5. **Settings:** `GENUI_MODE=hosted`, `GENUI_PUBLIC_URL`, `GENUI_HOSTED_URL`, `GENUI_AUTH_SECRET`, GitHub and Google OAuth apps. Password login and DCR off.
6. **Before opening sign-ups:**
   - quotas per workspace (components, versions, storage, hosted requests);
   - `Content-Security-Policy: sandbox` on `/v1/bundles/:hash`, since it serves customer HTML from the origin that holds sign-in cookies.
7. **Publish** `@genui/sdk`, `@genui/kit` and `@genui/cli` to npm, and `genui-sdk` to PyPI.

### Scaling

Writes (publish, promote, theme, sign-in) stay rare. Reads (SDK catalog polls, bundles, public MCP renders) carry the volume, are read-only and are versioned. So keep one write server as long as possible and move reads to Cloudflare's edge.

| Stage | When | Change |
|---|---|---|
| **0. POC** | Now | Setup above. |
| **1. Design partners** | First external workspace in production | <ul><li>Uptime checks, Sentry, staging.</li><li>Public MCP in its own container: same image, `/w/*` only, SQLite read-only. A flood can't starve sign-in.</li><li>Snapshot cache; `ETag`/304 on `/v1/catalog`.</li><li>Bundles move from SQLite to R2.</li></ul> |
| **2. Edge data plane** | First hosted workspace with real end-user traffic, or an uptime promise | <ul><li>On every change, the registry writes the workspace snapshot (catalog, bundles, recipes, theme) to R2/KV.</li><li>A Worker serves `/v1/catalog`, `/v1/bundles` and the public MCP from it. The snapshot holds no secrets, so the Worker needs nothing else.</li><li>The VPS keeps writes, the management MCP and OAuth. Its outages no longer reach end users.</li><li>Prerequisite: `@genui/sdk` runs on Workers (`nodejs_compat`). Check early.</li></ul> |
| **3. Redundant write plane** | A contractual SLA on management and releases (late) | Managed Postgres plus two app instances behind Cloudflare Load Balancing, or Workers + D1. Either way the store becomes async. The MCP handlers are built per request, so no sticky sessions. |
| **Enterprise** | Data residency, compliance | A dedicated instance (same image, its own VPS) or self-host. |

---

## 10. Out of v1

- Copilot / Gemini (A2UI)
- Python SDK
- `dependsOn` and pagination for selects
- Git sync, PR previews, per-consumer version pinning
- Multiple component sources with trust levels
- SSO, billing, analytics
- AI component builder beyond a Claude Code skill
