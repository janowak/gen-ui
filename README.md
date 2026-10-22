# genui

Forms, charts and custom components for MCP Apps, with built-in loading patterns, mounted into your MCP server through an SDK and released through a registry. See [V1-PLAN.md](V1-PLAN.md) for the product plan.

## Packages

| Path | What |
|---|---|
| `packages/format` | Zod schemas (form, chart, submit result, theme, component manifest) + helpers |
| `packages/ui` | Views (shadcn on Base UI + shadcn charts), written in React and run on Preact, built as single-file `form.html` / `chart.html` |
| `packages/sdk` | `mountGenUI(server, opts)`: `render_form`, `render_chart` and registry components, plus `createRegistryClient` |
| `packages/cli` | `genui` CLI: publish (beta or stable) / promote / rollback / list / theme / token |
| `apps/registry` | Registry: HTTP API on SQLite with workspaces, scoped tokens, immutable versions, beta/stable channels, theme |
| `apps/demo` | Example "company" MCP server with mock tools, using the SDK |
| `apps/playground` | Minimal local MCP Apps host for developing views |
| `apps/site` | Landing page (static, Vite + Tailwind on the views' shadcn theme from `@genui/ui/styles.css`): `pnpm --filter @genui/site dev` on http://localhost:5180 |
| `packages/kit` | `@genui/kit`: build custom components. `defineComponent` + `mount` runtime, and the `genui()` Vite plugin |
| `examples/rating` | Custom component (vanilla TS on `@genui/kit`) published through the registry |

Views run on Preact: `packages/ui` aliases `react` / `react-dom` to `@preact/compat` (about 57 KB gzipped less per view), while code, types and shadcn components stay React. [`runtime/preact.ts`](packages/ui/src/runtime/preact.ts) passes `ref` to function components as a prop, like React 19, so components from `shadcn add` work unchanged. Avoid React 19-only APIs (`use`, `useActionState`, `useOptimistic`, `<Activity>`) and fragments as direct children of Recharts charts.

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
GENUI_TOKEN=<admin> genui token publish ci-preview    # CI: publish to beta only
GENUI_TOKEN=<admin> genui token release ci-release    # CI: also publish to stable, promote, roll back
GENUI_TOKEN=<admin> genui token server demo           # SDK: read-only
GENUI_TOKEN=<publish> genui publish examples/rating                    # → beta
GENUI_TOKEN=<release> genui publish examples/rating --channel stable   # → beta and stable
GENUI_TOKEN=<release> genui promote rating --version 1.2.0             # stable → 1.2.0
GENUI_TOKEN=<release> genui rollback rating                            # stable → previous version
GENUI_TOKEN=<admin> genui theme theme.json                             # workspace theme
```

- Versions are immutable and must increase. Removing a prop or adding a required prop needs a major version bump.
- Re-publishing the same version with the same bundle and manifest is a no-op, so CI jobs can be re-run. Different content under an existing version is rejected.
- Publishing never moves a channel back to an older version. `promote --version` and `rollback` do.
- `--json` prints the registry's response, for scripts.

**From CI:** the CI setup picks the channel, not the code. Give each environment its own token and channel (`--channel` or `GENUI_CHANNEL`):

```yaml
# .github/workflows/genui.yml: pushes to main go to beta, releases go to stable
on:
  push: { branches: [main] }
  release: { types: [published] }
jobs:
  publish:
    runs-on: ubuntu-latest
    # Per GitHub environment: preview has a publish token and GENUI_CHANNEL=beta,
    # production a release token and GENUI_CHANNEL=stable.
    environment: ${{ github.event_name == 'release' && 'production' || 'preview' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile && pnpm build
      - run: pnpm exec genui publish .   # @genui/cli as a devDependency
        env:
          GENUI_URL: ${{ vars.GENUI_URL }}
          GENUI_TOKEN: ${{ secrets.GENUI_TOKEN }}
          GENUI_CHANNEL: ${{ vars.GENUI_CHANNEL }}
```
- A published component is `genui.component.json` (name, version, description, JSON Schema `props`, `tools` it calls) plus a single-file HTML bundle. With `@genui/kit`, both are generated into `dist/`; a hand-written manifest next to the sources also works.

## Build a component

`@genui/kit` hides the MCP Apps plumbing behind one contract. Describe the component once:

```ts
// src/component.ts: props validate in the view and publish as the tool's JSON Schema
export default defineComponent({
  name: "rating", version: "1.2.0", title: "Star rating",
  description: "Ask the user to rate something…",          // what the model reads
  props: z.object({ question: z.string(), max: z.number().int().min(3).max(10).optional() }),
  tools: ["save_rating"],                                   // tools it calls on the company's server
});
```

Render it with `mount(component, render)`. `render` gets the same live context on every change:

| Field | What |
|---|---|
| `status` | `waiting` → `streaming` → `ready`, or `error` / `cancelled` |
| `props` / `partial` | Validated props once ready; incomplete arguments while the model streams (preview only) |
| `tools.call(name, args)` | Waits for the render result; returns `{ ok, data }`, or `{ ok: false, unavailable: true }` without calling in registry previews (no data tools there) |
| `model.update(text)` / `model.send(text)` | Add context for the model's next turn / post a message as the user |
| `state.get()` / `state.set(value)` | Per-render state: a re-rendered message comes back as the user left it |
| `theme`, `display`, `app` | Host color scheme, display modes (fullscreen), and the raw MCP Apps `App` |

Host styles (`--color-*`, `--font-*`, dark mode) and the workspace theme (`--genui-primary`, `--genui-accent`, `--genui-radius`, `--genui-chart-1..5`) are applied to the document for you. In `vite.config.ts`, `plugins: [genui()]` from `@genui/kit/vite` inlines everything into one HTML file, checks the bundle size and generates the manifest. Then `genui publish .`.

**Develop locally** with `genui dev` (or plain `vite`) in the component directory. No registry, server or chat needed. It opens a local MCP Apps host:
- **Props:** a form generated from the props schema (or raw JSON), optionally streamed in like a model writes them. **Render** starts a new view; **Replay** keeps the view id, so saved `state` comes back.
- **Host:** light/dark, chat width, host style variables on/off, a workspace primary color, and registry preview mode (tools don't run).
- **Mock tools:** per declared tool, return data or return an error.
- **Log:** tool calls, model context updates and chat messages from the component.
- **Live reload:** saving any file re-renders the view with the same props and view id.

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
  watch: true, // long-lived servers: re-sync tools and send tools/list_changed on promote/rollback
});
```

- **Submit tools** return `{ ok: true, message?, result? }` or `{ ok: false, fieldErrors?, formError? }` in `structuredContent`.
- **Source tools** return any JSON. The model maps it with `itemsPath` / `idPath` / `labelPath` (selects) or `x` / `series` (charts).
