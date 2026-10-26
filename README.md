# genui

Forms, charts and custom components for MCP Apps, with built-in loading patterns, served by genui's MCP and forwarded from your MCP server through a thin SDK. A runtime registry keeps the versions, theme and recipes each environment (prod, staging, …) serves. See [V1-PLAN.md](V1-PLAN.md) for the product plan.

## Packages

| Path | What |
|---|---|
| `packages/format` | Zod schemas (form, chart, submit result, theme, component manifest) + helpers |
| `packages/ui` | Views (shadcn on Base UI + shadcn charts), written in React and run on Preact, built as single-file `form.html` / `chart.html` |
| `packages/sdk` | `@genui/sdk`: `connectGenUI` + `mountGenUI(server, { genui })` put genui's tools on your MCP server and forward calls to genui |
| `packages/sdk-python` | `genui-sdk`: the same adapter for Python MCP servers (`connect_genui`, `mount_genui`) |
| `packages/cli` | `genui` CLI: serve (a local MCP) / dev / publish (to an environment) / list / env / theme / recipe / token |
| `packages/runtime` | `@genui/runtime`: genui's end-user tools on an MCP server (`mountGenUI`: forms, charts, recipes, components from a `CatalogSource`). Used by the registry and by `genui serve` (`@genui/runtime/serve`); `@genui/runtime/local` reads component directories |
| `apps/registry` | genui server: the registry (HTTP API with workspaces, scoped tokens, immutable versions, environments with their own theme and recipes), the admin MCP at `/mcp`, and the end-user MCP at `/w/<workspace>/mcp` and `/w/<workspace>/<environment>/mcp` (on `@genui/runtime`). Runs on Node with SQLite (local, Docker) or on Cloudflare Workers with D1 (genui cloud) |
| `apps/demo` | Example "company" MCP server with mock tools, using the SDK |
| `apps/playground` | Minimal local MCP Apps host for developing views |
| `apps/site` | Landing page (static, Vite + Tailwind on the views' shadcn theme from `@genui/ui/styles.css`): `pnpm --filter @genui/site dev` on http://localhost:5180 |
| `packages/kit` | `@genui/kit`: build custom components. `defineComponent` + `mount` runtime, and the `genui()` Vite plugin |
| `examples/rating` | Custom component (vanilla TS on `@genui/kit`) published through the registry |

Views run on Preact: `packages/ui` aliases `react` / `react-dom` to `@preact/compat` (about 57 KB gzipped less per view), while code, types and shadcn components stay React. [`runtime/preact.ts`](packages/ui/src/runtime/preact.ts) passes `ref` to function components as a prop, like React 19, so components from `shadcn add` work unchanged. Avoid React 19-only APIs (`use`, `useActionState`, `useOptimistic`, `<Activity>`) and fragments as direct children of Recharts charts.

## Run locally

`genui serve` is a local genui MCP: forms, charts, recipes and your components, with no registry, account or token.

```bash
pnpm install && pnpm build
pnpm exec genui serve examples/rating --recipes examples/recipes   # http://localhost:4100/mcp
```

Then use it from one of these:
- **Claude Code:** `claude mcp add --transport http genui http://localhost:4100/mcp`
- **Claude Desktop, or any host that starts the MCP as a command:** `genui serve --stdio …` as the command, with absolute paths.
- **The playground:** `pnpm --filter @genui/playground dev` (http://localhost:5173), with the URL above.
- **Your own MCP server, through `@genui/sdk`:** `connectGenUI({ url: "http://localhost:4100/mcp", token: "local" })`. The demo company server does this by default: `pnpm --filter @genui/demo start` serves it on http://localhost:3001/mcp.

What `serve` does:
- **Reloads on save.** Components with a `vite.config` are rebuilt; theme, recipe and guide files are re-read. Connected clients get `list_changed` and the new tools. A rebuilt component gets a new `ui://` URI, and earlier versions keep loading for old messages.
- **Two modes**, as on the registry:
  - Without a token (Claude talking to it directly), it only renders: forms that call tools are rejected, and recipe values go back to the conversation.
  - With any token (`@genui/sdk`), views call your server's tools.
- **Keeps serving.** A component or file that doesn't load is reported and skipped.

Flags: `--theme`, `--recipes`, `--guide`, `--port`, `--host`, `--stdio`, `--suffix`, `--refresh-url`, `--no-build` (`genui --help`). Plan and status: [DEV-SERVE-PLAN.md](DEV-SERVE-PLAN.md).

**With the registry** (workspaces, environments, publishing): start it with `pnpm --filter @genui/registry start` (http://localhost:4000; first start prints an admin token). Create a server token with `genui token server demo`. Then point the demo at it in `.env.local` (gitignored):
- `GENUI_MCP_URL`: `http://localhost:4000/w/<workspace id>/mcp` for prod, `…/w/<workspace id>/<environment>/mcp` for another environment.
- `GENUI_MCP_TOKEN`: the server token.

## Database and migrations

The registry runs on SQLite either way: a file through `node:sqlite` on Node, or Cloudflare D1 on Workers. Both use the same SQL through one async interface (`apps/registry/src/db.ts`). D1 has no interactive transactions, so writes that belong together run in one atomic `batch`.

- **Schema:** numbered files in `apps/registry/migrations/`. Change it by adding a file; never edit one that has been applied.
  - **Node:** applies new files at startup.
  - **Cloudflare:** `wrangler d1 migrations apply`.
  - Both record what ran in the `d1_migrations` table.
- **better-auth's tables:** `0002_better_auth.sql`, generated from the plugins in `auth.ts`. After changing those plugins, run `pnpm --filter @genui/registry auth-schema` and turn the difference into a new migration.
- **Tests:** `pnpm --filter @genui/registry test` runs the suite twice, on `node:sqlite` and on a local D1 (Miniflare).
- **Size limit:** a D1 row holds at most 2 MB, so bundles are limited to 1.9 MB.

## Deploy

### genui cloud: Cloudflare Workers + D1

`apps/registry/wrangler.jsonc` runs the registry as a Worker on `api.app-mcp.com`, on the D1 database `genui` (EU jurisdiction), with Smart Placement so it runs next to its database. There's one deployment, production: changes are tested locally (below), then deployed.

Before the first deploy, set the secrets from `apps/registry`:

```bash
wrangler secret put GENUI_AUTH_SECRET
```

Also set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` the same way. `GENUI_AUTH_SECRET` comes from `openssl rand -hex 32`; keep it in the password manager, because changing it breaks every session and connector. Without a provider nobody can sign in: `curl https://api.app-mcp.com/auth/options` shows which are on.
- **Google:** a Google Cloud OAuth client of type "Web application", redirect URI `https://api.app-mcp.com/api/auth/callback/google`.
- **GitHub:** an OAuth App with callback URL `https://api.app-mcp.com/api/auth/callback/github`.
- **Sign-up gate (optional):** `GENUI_ALLOWED_EMAILS`, as a secret or a var, limits who gets a workspace (see [Management](#management-in-claude--chatgpt)).

Deploy: builds the sign-in pages, applies new migrations to the D1 database, then deploys the Worker.

```bash
pnpm deploy:registry
```

Locally, `cp apps/registry/.dev.vars.example apps/registry/.dev.vars`, then:

```bash
pnpm --filter @genui/registry dev:worker
```

It runs on http://localhost:8788 with D1 in `apps/registry/.wrangler/`. Run `pnpm build` first.

### Self-hosted: Docker

`apps/registry/Dockerfile` builds the same registry on Node 24 with SQLite in `/data`. `compose.yaml` runs it:

```bash
cp registry.env.example registry.env
```
```bash
docker compose up -d
```
```bash
docker compose logs registry
```

Fill in `registry.env` before starting; the logs show the admin token printed at first start. Back up the `genui-data` volume. Claude and ChatGPT need to reach `GENUI_PUBLIC_URL` over https, so put a reverse proxy or a tunnel in front.

## Registry and environments

genui is a runtime registry, not a release manager. Each workspace has environments: `prod` always exists, and admins add the others. An environment serves exactly what was last published or saved to it (component versions, its theme, its recipes), and nothing moves between environments on its own. There is no promote or rollback: to go back, publish the older version again.

```bash
export GENUI_URL=http://localhost:4000
GENUI_TOKEN=<admin> genui env add staging                              # prints staging's end-user MCP URL
GENUI_TOKEN=<admin> genui env set prod --refresh-url https://mcp.acme.com/genui/refresh  # your server, called on every change
GENUI_TOKEN=<admin> genui token publish ci                             # CI: publish to any environment
GENUI_TOKEN=<admin> genui token publish ci-preview --env staging       # CI: publish to staging only
GENUI_TOKEN=<admin> genui token server demo                            # SDK: the end-user MCP with data tools
GENUI_TOKEN=<publish> genui publish examples/rating --env staging      # → staging
GENUI_TOKEN=<publish> genui publish rating@1.2.0 --env prod            # prod serves 1.2.0, no rebuild
GENUI_TOKEN=<publish> genui publish examples/rating                    # → prod (the default)
GENUI_TOKEN=<publish> genui remove rating --env staging               # staging stops serving rating; versions stay
GENUI_TOKEN=<admin> genui env set prod --built-ins off                 # prod: only your components and recipes
GENUI_TOKEN=<admin> genui theme theme.json --env staging               # staging's theme
GENUI_TOKEN=<admin> genui recipe set recipe.json --env staging         # a recipe in staging
```

- Versions are immutable: one version, one bundle. They don't have to increase.
- Re-publishing the same version with the same bundle and manifest is a no-op, so CI jobs can be re-run. Different content under an existing version is rejected; publish `<name>@<version>` to serve an existing version in another environment.
- A breaking props change (a removed prop or a newly required one) against what the environment served before is a warning, not an error.
- `--json` prints the registry's response, for scripts.
- `remove` stops serving a component in an environment. Its versions stay published, so `publish <name>@<version>` serves one again and old messages keep rendering.
- Built-in forms and charts (`render_form`, `render_chart`) are on in every environment until an admin turns them off (`env set --built-ins off`, or the switch under `manage_components`). Recipes keep working either way.
- The CLI talks to genui cloud (`https://api.app-mcp.com`) unless `--url` or `GENUI_URL` names another registry. Publish tokens can also run `list` and `env list`.

**Each environment is its own connector.** Its end-user MCP lives at `/w/<workspace>/<environment>/mcp` (prod at `/w/<workspace>/mcp`). Outside prod, tool and prompt names end in the environment's name (`render_form_staging`, `render_rating_staging`, `/add_item_staging`), so a staging connector can sit next to prod's in the same chat and testers see which one ran.

**From CI:** the CI setup picks the environment, not the code. Give each GitHub environment its own token and `GENUI_ENV`:

```yaml
# .github/workflows/genui.yml: pushes to main go to staging, releases go to prod
on:
  push: { branches: [main] }
  release: { types: [published] }
jobs:
  publish:
    runs-on: ubuntu-latest
    # Per GitHub environment: staging has a publish token limited to staging and GENUI_ENV=staging,
    # production a publish token and GENUI_ENV=prod.
    environment: ${{ github.event_name == 'release' && 'production' || 'staging' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile && pnpm build
      - run: pnpm exec genui publish .   # @genui/cli as a devDependency
        env:
          GENUI_URL: ${{ vars.GENUI_URL }}
          GENUI_TOKEN: ${{ secrets.GENUI_TOKEN }}
          GENUI_ENV: ${{ vars.GENUI_ENV }}
```
- A published component is `genui.component.json` (name, version, description, JSON Schema `props`, `tools` it calls) plus a single-file HTML bundle. With `@genui/kit`, both are generated into `dist/`; a hand-written manifest next to the sources also works.

## Build a component

Start one outside this repo with `npx @genui/cli init my_poll`: a vanilla TypeScript component (no tools, so it works on the public MCP) with `dev`, `build`, `serve` and `genui:publish` scripts. The rest of this section is what's inside.

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
| `useState(initial, key?)` | `useState`-style state kept per render: `[value, setValue, { restored, persistence, flush }]`. A re-rendered message comes back as the user left it |
| `viewId` | The render id, once the result arrived. Pass it to submit tools as an idempotency key |
| `theme`, `display`, `app` | Host color scheme, display modes (fullscreen), and the raw MCP Apps `App` |

**Saved state.** Components never deal with storage or ids. The kit takes the render id from the result (`structuredContent.genui.id`, also in `_meta` for now) and saves state where the host allows:
- ChatGPT: its widget state (`privateContent`, which the model doesn't see), stored with the message.
- Claude and other MCP Apps hosts: `localStorage` in the view's sandbox, this browser only, swept after ~30 days.
- Storage blocked: memory, until the host renders the message again.

`persistence` says which applies. Which of these hold on each real host is checked in the M0 spike ([VIEW-STATE-PLAN.md](VIEW-STATE-PLAN.md) §7–8). Data that must hold (answered once, across devices) belongs in your own tool, keyed by `viewId`. React views use the same state through `useViewState` from `@genui/kit/react`.

Host styles (`--color-*`, `--font-*`, dark mode) and the workspace theme (`--genui-primary`, `--genui-accent`, `--genui-radius`, `--genui-chart-1..5`) are applied to the document for you. In `vite.config.ts`, `plugins: [genui()]` from `@genui/kit/vite` inlines everything into one HTML file, checks the bundle size and generates the manifest. Then `genui publish .`.

**Develop locally** with `genui dev` (or plain `vite`) in the component directory. No registry, server or chat needed. It opens a local MCP Apps host:
- **Props:** a form generated from the props schema (or raw JSON), optionally streamed in like a model writes them. **Render** starts a new view; **Replay** keeps the view id, so saved state comes back.
- **Host:** light/dark, chat width, host style variables on/off, a workspace primary color, and registry preview mode (tools don't run).
- **Saved state:** where `useState` saves, like a real host: `localStorage`, ChatGPT widget state (a `window.openai` stand-in), or none (memory only). **Clear** forgets it.
- **Mock tools:** per declared tool, return data or return an error.
- **Log:** tool calls, model context updates, chat messages and saved state from the component.
- **Live reload:** saving any file re-renders the view with the same props and view id.

To try it in a real host, run `genui serve` in the component directory and add http://localhost:4100/mcp to Claude (see [Run locally](#run-locally)). The component is rebuilt on save, and the host gets the new version without reconnecting.

## Management in Claude / ChatGPT

The registry serves its own MCP server at `/mcp`. Add it as a custom connector. People sign in with OAuth (better-auth); tokens are bound to `<GENUI_PUBLIC_URL>/mcp`.

| Tool | Who | What |
|---|---|---|
| `manage_components` | members, admins | The version each environment serves, with a picker for the active environment, and whether the built-in forms and charts are on |
| `use_environment` | members, admins | Switches what your previews, theme and recipes show (default prod). Saved per person; end users are unaffected |
| `open_theme_controller`, `manage_recipes`, `draft_recipe` | members (read-only), admins | The active environment's theme and recipes |
| `preview_<name>` | members, admins | Renders the version the active environment serves, with sample props |
| `manage_workspace` | members (read-only), admins | People and invites, each environment's end-user MCP address, whether it's public, and tokens (admins). The model can prefill an invite |
| `theme_save`, `recipe_save`, `recipe_delete`, `component_remove`, `built_ins_set` | admins | App-only: run only when a person clicks in the views, never by the model |
| `member_invite`, `invite_cancel`, `token_create`, `token_revoke`, `public_set` | admins | App-only, in the workspace view. A new token is shown once, in the view only: it never reaches the model |

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
- Invites: from the workspace view (`manage_workspace`). Claimed at the person's next sign-in with that verified email, even if they already have a workspace (an unused one is deleted).
- `GENUI_ALLOWED_EMAILS`: sign-up gate, comma-separated emails and `@domain` entries. When set, only those verified emails get a workspace at first sign-in; anyone else is refused until invited. Existing members and invited people always get in.
- Client registration: Claude and ChatGPT use Client ID Metadata Documents. `GENUI_ALLOW_DCR=true` enables open dynamic registration, for local dev or DCR-only clients.

**Try it locally:** open `http://localhost:5173/?server=http://localhost:4000/mcp`. The playground runs the same OAuth flow a connector does: discovery → registration → sign-in → consent.

## Publish the npm packages

`@genui/cli`, `@genui/kit` and `@genui/sdk` are what users install; they depend on `@genui/format`, `@genui/runtime` and `@genui/ui`, so all six go out together, with the same version. `pnpm publish` turns `workspace:^` into real version ranges. Once, create the `genui` organization on npmjs.com and `npm login`. Then, after bumping `version` in each `packages/*/package.json`:

```bash
pnpm build && pnpm -r --filter "./packages/*" publish --access public --dry-run
```

Drop `--dry-run` to publish; pnpm refuses on uncommitted changes or a branch other than master. To try a release without publishing, `pnpm pack` each package and point a test project at the tarballs (`file:` dependencies plus `overrides` for the internal ones).

## Use the SDK

genui's tools (`render_form`, `render_chart`, `use_recipe`, `render_<component>`) are served by genui's end-user MCP. It's public by default: anyone with its address can add it as a connector, with no data tools. An admin can make it private in the workspace view (`manage_workspace`); then only servers with a server token can use it. The SDK puts them on your MCP server, next to your own tools, and forwards their calls to genui with a server token. genui's views call your tools through the host, so your data tools and their results never leave your server.

```ts
import { connectGenUI, mountGenUI } from "@genui/sdk";

// Once per process: lists genui's tools and prompts in the background. The URL picks the
// environment: /w/<workspace>/mcp for prod, /w/<workspace>/<environment>/mcp for the others.
const genui = connectGenUI({ url: process.env.GENUI_MCP_URL, token: SERVER_TOKEN });

// Per server instance:
await mountGenUI(server, {
  genui,
  watch: true, // long-lived servers: re-sync tools and send list_changed after a publish or save
});
```

Each deployment of your server (dev, staging, prod) points `GENUI_MCP_URL` at its environment. To serve two environments from one process (staff on staging, say), connect twice and pass the right client per request.

**Picking up changes.** Every publish, theme or recipe change bumps the environment's revision. When genui's tools are used and the SDK's copy is older than `refreshSeconds` (default 60), it checks the revision in the background and re-lists only if it changed; a host never waits on it. To serve changes right away, mount the SDK's refresh endpoint and register its URL. genui then calls it on every change:

```ts
import { refreshHandler } from "@genui/sdk";

app.post("/genui/refresh", (c) => refreshHandler(genui)(c.req.raw)); // Hono; any (Request) => Response framework
// Express: app.post("/genui/refresh", (req, res) => { void genui.refresh(req.body?.revision); res.sendStatus(202); });
```

```bash
genui env set prod --refresh-url https://mcp.acme.com/genui/refresh   # "" clears it; genui env list shows the last call
```

The call carries only the environment and its revision, and reaches one instance behind your load balancer; the others catch up at their next check. In genui's cloud the URL must be public https.

Python: `genui = connect_genui(url, token)`, then `mount_genui(server, genui)`. See [packages/sdk-python](packages/sdk-python/README.md).

- **Fast, not offline.** `tools/list` is answered from memory, and `ui://` resources are content-hashed, so each is fetched once. Calls always go to genui. When genui is down, they return "genui is unavailable right now, try again shortly.", and the model tells the user.
- **Cloud or self-hosted.** In genui's cloud, genui sees what the model passes to its tools (form specs, pre-filled values, inline chart rows), never your own tool calls or results. If that matters, run the genui server yourself: it's the same image.

- **Submit tools** return `{ ok: true, message?, result? }` or `{ ok: false, fieldErrors?, formError? }` in `structuredContent`.
- **Answered once:** give a submit tool an idempotency-key parameter (e.g. `request_id`) and name it in `submit.idempotencyParam`. Forms pass one id per rendered form, so a repeated submit (another device, a view closed mid-submit) can return the first result. Forms keep their draft and their submitted state per render; `persistDraft: false` keeps answers out of storage for sensitive forms.
- **Source tools** return any JSON. The model maps it with `itemsPath` / `idPath` / `labelPath` (selects) or `x` / `series` (charts).
