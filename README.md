# genui

Forms, charts and custom components for MCP Apps, with built-in loading patterns, mounted into your MCP server through an SDK and released through a registry. See [V1-PLAN.md](V1-PLAN.md) for the product plan.

## Packages

| Path | What |
|---|---|
| `packages/format` | Zod schemas (form, chart, submit result, theme, component manifest) + helpers |
| `packages/ui` | React views (shadcn on Base UI + shadcn charts) built as single-file `form.html` / `chart.html` |
| `packages/sdk` | `mountGenUI(server, opts)`: `render_form`, `render_chart` and registry components, plus `createRegistryClient` |
| `packages/cli` | `genui` CLI: publish / promote / rollback / list / theme / token |
| `apps/registry` | Registry: HTTP API on SQLite with workspaces, scoped tokens, immutable versions, beta/stable channels, theme |
| `apps/demo` | Example "company" MCP server with mock tools, using the SDK |
| `apps/playground` | Minimal local MCP Apps host for developing views |
| `examples/rating` | Custom component (vanilla TS) published through the registry |

## Run locally

```bash
pnpm install
pnpm build
pnpm --filter @genui/registry start     # http://localhost:4000; first start prints an admin token
pnpm --filter @genui/demo start         # MCP server on http://localhost:3001/mcp
pnpm --filter @genui/playground dev     # host on http://localhost:5173 (?channel=beta for beta)
```

The demo reads `.env.local` (gitignored) for `GENUI_REGISTRY_URL` and `GENUI_REGISTRY_TOKEN`. Without them it runs without a registry.

## Registry and release flow

```bash
export GENUI_URL=http://localhost:4000
GENUI_TOKEN=<admin> genui token publish ci     # token for CI: can publish to beta only
GENUI_TOKEN=<admin> genui token server demo    # token for the SDK: read-only
GENUI_TOKEN=<publish> genui publish examples/rating   # → beta
GENUI_TOKEN=<admin> genui promote rating              # beta → stable
GENUI_TOKEN=<admin> genui rollback rating             # stable → previous version
GENUI_TOKEN=<admin> genui theme theme.json            # workspace theme
```

- Versions are immutable and must increase. Removing a prop or adding a required prop needs a major version bump.
- A component directory contains `genui.component.json` (name, version, description, JSON Schema `props`, `tools` it calls) and a single-file HTML bundle at `dist/index.html`.

## Management in Claude / ChatGPT

The registry serves its own MCP server at `/mcp`. Add it as a custom connector. People sign in with OAuth (better-auth); tokens are bound to `<GENUI_PUBLIC_URL>/mcp`.

| Tool | Who | What |
|---|---|---|
| `manage_components` | members, admins | Component list with beta/stable; admins get Promote / Roll back buttons |
| `open_theme_controller` | members (read-only), admins | Theme editor with a live preview |
| `preview_<name>` | members, admins | Renders the beta version of a component with sample props |
| `component_promote`, `component_rollback`, `theme_save` | admins | App-only: run only when a person clicks in the views, never by the model |

**Sign-in options (env):**
- Social login: `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- Company IdP via OIDC: `GENUI_OIDC_ISSUER`, `GENUI_OIDC_CLIENT_ID`, `GENUI_OIDC_CLIENT_SECRET`, `GENUI_OIDC_NAME`.
- `GENUI_PASSWORD_LOGIN=true`: email + password, for local dev and small installs.

**Other settings:**
- `GENUI_PUBLIC_URL`: the registry's public URL (Claude / ChatGPT must reach it; use a tunnel for local testing).
- `GENUI_AUTH_SECRET`: required in production.
- `GENUI_MODE`:
  - `self-hosted` (default): everyone who can sign in joins the workspace. The first person is admin, plus anyone listed in `GENUI_ADMIN_EMAILS`.
  - `hosted`: each new person gets a personal workspace.
- `genui invite <email> --role admin|member`: invite people. The invite is claimed at their first sign-in.
- Client registration: Claude and ChatGPT use Client ID Metadata Documents. `GENUI_ALLOW_DCR=true` enables open dynamic registration, for local dev or DCR-only clients.

**Try it locally:** open `http://localhost:5173/?server=http://localhost:4000/mcp`. The playground runs the same OAuth flow a connector does: discovery → registration → sign-in → consent.

## Use the SDK

```ts
import { createRegistryClient, mountGenUI } from "@genui/sdk";

// Once per process: pulls catalogs, verifies bundle hashes, keeps the last good version.
const registry = createRegistryClient({ url: REGISTRY_URL, token: SERVER_TOKEN, cacheFile: ".genui-cache.json" });

// Per server instance:
await mountGenUI(server, {
  registry,
  channel: userIsBetaTester ? "beta" : "stable",
  // Tools views may call. Everything else is rejected before the view renders.
  allowTools: { sources: ["search_customers", "get_revenue"], submit: ["create_order", "save_rating"] },
  watch: true, // long-lived servers: re-sync tools and send tools/list_changed on promote/rollback
});
```

- **Submit tools** return `{ ok: true, message?, result? }` or `{ ok: false, fieldErrors?, formError? }` in `structuredContent`.
- **Source tools** return any JSON. The model maps it with `itemsPath` / `idPath` / `labelPath` (selects) or `x` / `series` (charts).
