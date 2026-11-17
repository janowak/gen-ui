# app-mcp

Forms, charts and custom components for MCP Apps, with built-in loading patterns, served by app-mcp's MCP and forwarded from your MCP server through a thin SDK. A runtime registry keeps the versions, theme, instructions and workflows each environment (prod, staging, …) serves. See [V1-PLAN.md](V1-PLAN.md) for the product plan.

## Packages

| Path | What |
|---|---|
| `packages/format` | Zod schemas (form, chart, submit result, theme, component manifest) + helpers |
| `packages/ui` | Views (shadcn on Base UI + shadcn charts), written in React and run on Preact, built as single-file `form.html` / `chart.html` |
| `packages/sdk` | `@app-mcp/sdk`: `connectAppMcp` + `mountAppMcp(server, { appMcp })` put app-mcp's tools on your MCP server and forward calls to app-mcp |
| `packages/host` | `@app-mcp/host`: embed an interactive assistant or standalone MCP App view in your own application |
| `packages/sdk-python` | `app-mcp-sdk`: the same adapter for Python MCP servers (`connect_app_mcp`, `mount_app_mcp`) |
| `packages/cli` | `app-mcp` CLI: serve (a local MCP) / dev / publish (components and workflows, to an environment) / list / env / theme / workflow / instructions / token |
| `packages/runtime` | `@app-mcp/runtime`: app-mcp's end-user tools on an MCP server (`mountAppMcp`: forms, charts, components and workflow prompts from a `CatalogSource`). Used by the registry and by `app-mcp serve` (`@app-mcp/runtime/serve`); `@app-mcp/runtime/local` reads component dirs and workflow files |
| `apps/registry` | app-mcp server: the registry (HTTP API with workspaces, scoped tokens, immutable versions, environments with their own theme, instructions and workflows), the admin MCP at `/mcp`, and the end-user MCP at `/w/<workspace>/mcp` and `/w/<workspace>/<environment>/mcp` (on `@app-mcp/runtime`). Runs on Node with SQLite (local, Docker) or on Cloudflare Workers with D1 (app-mcp cloud) |
| `apps/demo` | Example "company" MCP server with mock tools, using the SDK |
| `apps/playground` | Minimal local MCP Apps host for developing views |
| `apps/site` | Landing page (static, Vite + Tailwind on the views' shadcn theme from `@app-mcp/ui/styles.css`): `pnpm --filter @app-mcp/site dev` on http://localhost:5180 |
| `packages/kit` | `@app-mcp/kit`: build custom components. `defineComponent` + `mount` runtime, and the `appMcp()` Vite plugin |
| `examples/rating` | Custom component (vanilla TS on `@app-mcp/kit`) published through the registry, with workflows next to it in `workflows/` |
| `examples/wrapped` | AI Wrapped demo: `render_wrapped` shows a Wrapped-style card deck about the user's year with AI. Share links carry the cards in the URL fragment and open on the site's static `/wrapped/` page (the same bundle), so nothing is stored |
| `examples/roast-my-github` | "Roast my GitHub" demo component: a roast card from public GitHub stats (`github_roast_stats` on the demo server), with roast harder / be nicer and a share link that opens the card on the site's `/roast` page. The card travels in the link's fragment, so nothing is stored |

Views run on Preact: `packages/ui` aliases `react` / `react-dom` to `@preact/compat` (about 57 KB gzipped less per view), while code, types and shadcn components stay React. [`runtime/preact.ts`](packages/ui/src/runtime/preact.ts) passes `ref` to function components as a prop, like React 19, so components from `shadcn add` work unchanged. Avoid React 19-only APIs (`use`, `useActionState`, `useOptimistic`, `<Activity>`) and fragments as direct children of Recharts charts.

## Run locally

`app-mcp serve` is a local app-mcp MCP: forms, charts and your components with their workflows, with no registry, account or token.

```bash
pnpm install && pnpm build
pnpm exec app-mcp serve examples/rating   # http://localhost:4100/mcp
```

Then use it from one of these:
- **Claude Code:** `claude mcp add --transport http app-mcp http://localhost:4100/mcp`
- **Claude Desktop, or any host that starts the MCP as a command:** `app-mcp serve --stdio …` as the command, with absolute paths.
- **The playground:** `pnpm --filter @app-mcp/playground dev` (http://localhost:5173), with the URL above.
- **Your own MCP server, through `@app-mcp/sdk`:** `connectAppMcp({ url: "http://localhost:4100/mcp", token: "local" })`. The demo company server does this by default: `pnpm --filter @app-mcp/demo start` serves it on http://localhost:3001/mcp.

What `serve` does:
- **Reloads on save.** Components with a `vite.config` are rebuilt; theme, instructions and workflow files are re-read. Connected clients get `list_changed` and the new tools. A rebuilt component gets a new `ui://` URI, and earlier versions keep loading for old messages.
- **Two modes**, as on the registry:
  - Without a token (Claude talking to it directly), it only renders: forms that call tools are rejected, and form values go back to the conversation.
  - With any token (`@app-mcp/sdk`), views call your server's tools.
- **Keeps serving.** A component or file that doesn't load is reported and skipped.

Flags: `--theme`, `--instructions`, `--port`, `--host`, `--stdio`, `--suffix`, `--refresh-url`, `--no-build` (`app-mcp --help`). Plan and status: [DEV-SERVE-PLAN.md](DEV-SERVE-PLAN.md).

**With the registry** (workspaces, environments, publishing): start it with `pnpm --filter @app-mcp/registry start` (http://localhost:4000; first start prints an admin token). Create a server token with `app-mcp token server demo`. Then point the demo at it in `.env.local` (gitignored):
- `APP_MCP_MCP_URL`: `http://localhost:4000/w/<workspace slug>/mcp` for prod, `…/w/<workspace slug>/<environment>/mcp` for another environment.
- `APP_MCP_MCP_TOKEN`: the server token.

**In a worktree** (several agents, or you, running the stack side by side): run `pnpm dev:setup` in it.
- **Ports:** it picks a free block for the worktree: registry 40000+10n, then serve, demo, playground and site on the next four ports.
- **Database and data:** the registry gets its own SQLite file, seeded with a workspace, a password user, `examples/rating` and `examples/roast-my-github`.
- **Config:** everything that differs goes in `.env.worktree`, which the registry, the demo and `pnpm app-mcp` load after `.env.local`. Claude Code copies `.env.local` into the worktrees it creates (`.worktreeinclude`); setup copies it for `git worktree add`.
- **Services:** `.claude/launch.json` gets the worktree's ports, so services start by name as usual.
- **Not in worktrees:** wrangler, tunnels and deploys. `pnpm test` covers D1. The deploy scripts refuse to run outside the main checkout.

In the main checkout, `pnpm dev:setup` only installs and builds. Agents follow `.claude/skills/worktree`.

## Database and migrations

The registry runs on SQLite either way: a file through `node:sqlite` on Node, or Cloudflare D1 on Workers. Both use the same SQL through one async interface (`apps/registry/src/db.ts`). D1 has no interactive transactions, so writes that belong together run in one atomic `batch`.

- **Schema:** numbered files in `apps/registry/migrations/`. Change it by adding a file; never edit one that has been applied.
  - **Node:** applies new files at startup.
  - **Cloudflare:** `wrangler d1 migrations apply`.
  - Both record what ran in the `d1_migrations` table.
- **better-auth's tables:** `0002_better_auth.sql`, generated from the plugins in `auth.ts`. After changing those plugins, run `pnpm --filter @app-mcp/registry auth-schema` and turn the difference into a new migration.
- **Tests:** `pnpm --filter @app-mcp/registry test` runs the suite twice, on `node:sqlite` and on a local D1 (Miniflare).
- **Size limits:** component builds/publishes allow up to 25 MB. Static hosting extracts JS/CSS before storing the shell; HTML left in D1 is limited to 1.9 MB. Registries embedded without static hosting retain the 1.9 MB publish limit.

## Deploy

### app-mcp cloud: Cloudflare Workers + D1

`apps/registry/wrangler.jsonc` runs the registry as a Worker on `api.app-mcp.com`, on the D1 database `app-mcp` (EU jurisdiction), with Smart Placement so it runs next to its database. There's one deployment, production: changes are tested locally (below), then deployed.

Before the first deploy, set the secrets from `apps/registry`:

```bash
wrangler secret put APP_MCP_AUTH_SECRET
```

Also set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` the same way. `APP_MCP_AUTH_SECRET` comes from `openssl rand -hex 32`; keep it in the password manager, because changing it breaks every session and connector. Without a provider nobody can sign in: `curl https://api.app-mcp.com/auth/options` shows which are on.
- **Google:** a Google Cloud OAuth client of type "Web application", redirect URI `https://api.app-mcp.com/api/auth/callback/google`.
- **GitHub:** an OAuth App with callback URL `https://api.app-mcp.com/api/auth/callback/github`.
- **Sign-up gate (optional):** `APP_MCP_ALLOWED_EMAILS`, as a secret or a var, limits who gets a workspace (see [Management](#management-in-claude--chatgpt)).
- **Quotas:** with `APP_MCP_MODE=hosted`, `HOSTED_QUOTAS` in `apps/registry/src/quotas.ts` caps what each person and workspace can make (workspaces, environments, components, new versions a day, workflows, tokens, invites). Request rates per workspace come from Cloudflare rate limiting bindings in `wrangler.jsonc` (`WRITE_LIMITER` for `/v1` changes, `END_USER_MCP_LIMITER` for the end-user MCP). Self-hosted registries have neither.

Create the static asset bucket once with `wrangler r2 bucket create app-mcp-assets`.
A separate edge Worker (`wrangler.assets.jsonc`) serves `assets.app-mcp.com` without database placement, auth setup, API or MCP routes. The registry Worker remains near D1; static requests stay at the edge.
`APP_MCP_ASSET_URL` configures its public directory URL (default `https://assets.app-mcp.com/assets/`); set the same URL in both Worker configs and update the asset Worker’s custom domain route if using another hostname. The shared R2 binding/bucket is configured in both Worker configs; when changing the bucket name, also set `APP_MCP_ASSET_BUCKET` for the deployment upload script.

Deploy builds the sign-in pages and static view artifacts, uploads built-in assets to R2 (retaining previous hashes), applies new migrations, then deploys the asset Worker followed by the registry Worker. Built-ins are also included as static deployment assets so cold isolates do not need to upload them. Uploaded components use R2; asset responses are cached at the edge and in browsers with a one-year immutable policy.

```bash
pnpm deploy:registry
```

Locally, `cp apps/registry/.dev.vars.example apps/registry/.dev.vars`, then:

```bash
pnpm --filter @app-mcp/registry dev:worker
```

It runs on http://localhost:8788 with D1 in `apps/registry/.wrangler/`. Start `pnpm --filter @app-mcp/registry dev:assets` in a second terminal for static assets on http://localhost:8789. The example `.dev.vars` points asset URLs there. Run `pnpm build` first.

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

Fill in `registry.env` before starting; the logs show the admin token printed at first start. Back up the `app-mcp-data` volume, including the static asset directory next to the database. Claude and ChatGPT need to reach `APP_MCP_PUBLIC_URL` over https, so put a reverse proxy or a tunnel in front.

## Registry and environments

app-mcp is a runtime registry, not a release manager. Each workspace has environments: `prod` always exists, and admins add the others. An environment serves exactly what was last published or saved to it (component versions, its theme, its instructions and workflows), and nothing moves between environments on its own. There is no promote or rollback: to go back, publish the older version again.

```bash
export APP_MCP_URL=http://localhost:4000
APP_MCP_TOKEN=<admin> app-mcp env add staging                              # prints staging's end-user MCP URL
APP_MCP_TOKEN=<admin> app-mcp env set prod --refresh-url https://mcp.acme.com/app-mcp/refresh  # your server, called on every change
APP_MCP_TOKEN=<admin> app-mcp token publish ci                             # CI: publish to any environment
APP_MCP_TOKEN=<admin> app-mcp token publish ci-preview --env staging       # CI: publish to staging only
APP_MCP_TOKEN=<admin> app-mcp token server demo                            # SDK: the end-user MCP with data tools
APP_MCP_TOKEN=<publish> app-mcp publish examples/rating --env staging      # → staging
APP_MCP_TOKEN=<publish> app-mcp publish rating@1.2.0 --env prod            # prod serves 1.2.0, no rebuild
APP_MCP_TOKEN=<publish> app-mcp publish examples/rating                    # → prod (the default), component and its workflows
APP_MCP_TOKEN=<publish> app-mcp remove rating --env staging               # staging stops serving rating; versions stay
APP_MCP_TOKEN=<admin> app-mcp env set prod --built-ins off                 # prod: only your components, no render_form / render_chart
APP_MCP_TOKEN=<admin> app-mcp theme theme.json --env staging               # staging's theme
APP_MCP_TOKEN=<admin> app-mcp instructions instructions.md --env staging  # staging's MCP instructions
```

- Versions are immutable: one version, one bundle. They don't have to increase.
- Re-publishing the same version with the same bundle and manifest is a no-op, so CI jobs can be re-run. Different content under an existing version is rejected; publish `<name>@<version>` to serve an existing version in another environment.
- A breaking props change (a removed prop or a newly required one) against what the environment served before is a warning, not an error.
- `--json` prints the registry's response, for scripts.
- `remove` stops serving a component in an environment. Its versions stay published, so `publish <name>@<version>` serves one again and old messages keep rendering.
- Built-in forms and charts (`render_form`, `render_chart`) are on in every environment until an admin turns them off (`env set --built-ins off`, or the switch under `manage_components`).
- The CLI talks to app-mcp cloud (`https://api.app-mcp.com`) unless `--url` or `APP_MCP_URL` names another registry. Publish tokens can also run `list` and `env list`.
- On your own machine, `app-mcp login` replaces the tokens above: it opens the registry's `/cli` page, you click Allow, and the CLI keeps a token for you in `~/.config/app-mcp/credentials.json` (per registry URL). It is not tied to a workspace: it reaches every workspace you're in, with your role there read on every request (admins do everything, members read). Each request names its workspace: `--workspace` (or `APP_MCP_WORKSPACE`), else the one `app-mcp use <workspace>` picked, which starts as the one you used last. With a single workspace, nothing needs naming. The CLI never follows the console's active workspace, so switching in the browser doesn't move where a terminal publishes. `app-mcp workspaces` lists them; `--token` and `APP_MCP_TOKEN` win over the saved token, so CI keeps using publish tokens, which stay bound to their workspace. `app-mcp whoami` prints who you are and the workspace with its admin link and end-user MCP; `app-mcp logout` revokes the token.
- `app-mcp guide` prints the setup guide for AI coding agents (`packages/cli/guide.md`), and `app-mcp init` writes an `AGENTS.md` into each new component.

**Workflows sit next to components.** A workflow is a playbook for the model in your own words: `<name>.workflow.md` in a component dir or its `workflows/`, with YAML frontmatter and the steps as the body. `app-mcp publish <dir>` sends the dir's component and workflows to the environment, with the same publish token (a dir may hold only workflows). `app-mcp workflow set|rm|list` handles single ones; admins can also edit them from the `manage_workflows` view.

```md
---
title: New order
description: The user wants to create an order for a customer.
params:                       # with params: the slash command /create_order taking them
  - name: customer
    description: Customer name, if you know it
---
1. Look the customer up with search_customers.
2. Show the order form with render_form … submit to create_order.
```

A workflow without params isn't a command: hosts get it in the MCP server instructions, after the environment's own instructions (`app-mcp instructions <file.md>`). Those instructions go into every conversation, so together they're capped at 50000 characters.

**Each environment is its own connector.** Its end-user MCP lives at `/w/<workspace>/<environment>/mcp` (prod at `/w/<workspace>/mcp`). Outside prod, tool and prompt names end in the environment's name (`render_form_staging`, `render_rating_staging`, `/create_order_staging`), so a staging connector can sit next to prod's in the same chat and testers see which one ran.

**From CI:** the CI setup picks the environment, not the code. Give each GitHub environment its own token and `APP_MCP_ENV`:

```yaml
# .github/workflows/app-mcp.yml: pushes to main go to staging, releases go to prod
on:
  push: { branches: [main] }
  release: { types: [published] }
jobs:
  publish:
    runs-on: ubuntu-latest
    # Per GitHub environment: staging has a publish token limited to staging and APP_MCP_ENV=staging,
    # production a publish token and APP_MCP_ENV=prod.
    environment: ${{ github.event_name == 'release' && 'production' || 'staging' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile && pnpm build
      - run: pnpm exec app-mcp publish .   # @app-mcp/cli as a devDependency
        env:
          APP_MCP_URL: ${{ vars.APP_MCP_URL }}
          APP_MCP_TOKEN: ${{ secrets.APP_MCP_TOKEN }}
          APP_MCP_ENV: ${{ vars.APP_MCP_ENV }}
```
- A published component is `app-mcp.component.json` (name, version, description, JSON Schema `props`, `tools` it calls) plus a single-file HTML bundle. With `@app-mcp/kit`, both are generated into `dist/`; a hand-written manifest next to the sources also works.

## Static resource hosting

Publishing uploads all JS/CSS objects before activating an immutable component version. The registry stores the small HTML shell and its MCP CSP metadata together. Current resources, historical versions, previews, built-ins and SDK forwarding preserve that metadata. Asset URLs use full SHA-256 hashes, and shells include subresource integrity checks; JSON script data stays inline. Existing component builds and inline versions remain compatible. Images/fonts embedded in scripts or styles are cached with those files; separate asset builds/code splitting are not required or supported by this publishing format yet.

On Node, `APP_MCP_ASSET_DIR` defaults to `<APP_MCP_DB>.assets`; `APP_MCP_ASSET_URL` defaults to `<APP_MCP_PUBLIC_URL>/assets/`. Set it to a dedicated hostname or CDN URL routed to the registry's asset directory path. Serving uses CORS for anonymous module/font loading, explicit MIME types and immutable caching; no authentication is required for assets. Embedded registries can supply `staticHosting: { baseURL, store }` and prepare their built-ins with `hostViews`.

Keep asset URLs and old objects available indefinitely for old conversations and rollback; changing the configured URL does not rewrite previous releases (publish a new version to adopt a new URL). Never include secrets or user data in static files, even in a private workspace. A failed publish may leave unreferenced content-addressed objects, but never activates a partial release. There is no automatic garbage collection.

## Build a component

Start one outside this repo with `npx @app-mcp/cli init my_poll`: a vanilla TypeScript component (no tools, so it works on the public MCP) with `dev`, `build`, `serve` and `app-mcp:publish` scripts. The rest of this section is what's inside.

`@app-mcp/kit` hides the MCP Apps plumbing behind one contract. Describe the component once:

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

**Saved state.** Components never deal with storage or ids. The kit takes the render id from the result (`structuredContent.appMcp.id`, also in `_meta` for now) and saves state where the host allows:
- ChatGPT: its widget state (`privateContent`, which the model doesn't see), stored with the message.
- Claude and other MCP Apps hosts: `localStorage` in the view's sandbox, this browser only, swept after ~30 days.
- Storage blocked: memory, until the host renders the message again.

`persistence` says which applies. Which of these hold on each real host is checked in the M0 spike ([VIEW-STATE-PLAN.md](VIEW-STATE-PLAN.md) §7–8). Data that must hold (answered once, across devices) belongs in your own tool, keyed by `viewId`. React views use the same state through `useViewState` from `@app-mcp/kit/react`.

Host styles (`--color-*`, `--font-*`, dark mode) and the workspace theme (`--app-mcp-primary`, `--app-mcp-accent`, `--app-mcp-radius`, `--app-mcp-chart-1..5`) are applied to the document for you. In `vite.config.ts`, `plugins: [appMcp()]` from `@app-mcp/kit/vite` inlines everything into one HTML file, checks the 25 MB build budget and generates the manifest. Publishing extracts executable inline scripts and styles into content-addressed static files, leaving an HTML shell with `<script>`/`<link>` references. Local development keeps the self-contained HTML. Then `app-mcp publish .`.

**Develop locally** with `app-mcp dev` (or plain `vite`) in the component directory. No registry, server or chat needed. It opens a local MCP Apps host:
- **Props:** a form generated from the props schema (or raw JSON), optionally streamed in like a model writes them. **Render** starts a new view; **Replay** keeps the view id, so saved state comes back.
- **Host:** light/dark, chat width, host style variables on/off, a workspace primary color, and registry preview mode (tools don't run).
- **Saved state:** where `useState` saves, like a real host: `localStorage`, ChatGPT widget state (a `window.openai` stand-in), or none (memory only). **Clear** forgets it.
- **Mock tools:** per declared tool, return data or return an error.
- **Log:** tool calls, model context updates, chat messages and saved state from the component.
- **Live reload:** saving any file re-renders the view with the same props and view id.

To try it in a real host, run `app-mcp serve` in the component directory and add http://localhost:4100/mcp to Claude (see [Run locally](#run-locally)). The component is rebuilt on save, and the host gets the new version without reconnecting.

## Management in Claude / ChatGPT

The registry serves its own MCP server at `/mcp`. Add it as a custom connector. People sign in with OAuth (better-auth); tokens are bound to `<APP_MCP_PUBLIC_URL>/mcp`.

| Tool | Who | What |
|---|---|---|
| `manage_components` | members, admins | The version each environment serves, with a picker for the active environment, and whether the built-in forms and charts are on |
| `use_environment` | members, admins | Switches what your previews, theme, instructions and workflows show (default prod). Saved per person; end users are unaffected |
| `open_theme_controller`, `manage_instructions`, `draft_instructions`, `manage_workflows`, `draft_workflow` | members (read-only), admins | The active environment's theme, instructions and workflows |
| `preview_<name>` | members, admins | Renders the version the active environment serves, with sample props |
| `list_workspaces`, `switch_workspace`, `create_workspace` | members, admins | The workspaces you're in. The console and your connectors manage your active one; switching in any of them moves them all. A connector is signed in as you, not to a workspace, so one connector covers every workspace (creating one needs a hosted registry) |
| `show_workspace`, `list_members` | members, admins | The workspace at a glance (public or private, each environment's end-user MCP address, counts), and the people and pending invites |
| `list_tokens`, `edit_connector` | admins | Tokens (never their secrets), and the form for how hosts list the end-user MCP (the model can prefill it) |
| `workspace_rename`, `public_set`, `environment_create`, `member_invite`, `invite_cancel`, `member_set_role`, `member_remove`, `connector_set`, `token_create`, `token_revoke` | admins | Plain tools the model calls directly; the views use them too. The workspace always keeps an admin |
| `theme_save`, `instructions_save`, `workflow_save`, `workflow_delete`, `component_remove`, `built_ins_set`, `connector_icon_set` | admins | App-only: run only when a person clicks in the views, never by the model |
| `token_reveal`, `token_rotate` | admins | App-only, in the tokens view. `token_create` makes a token with no secret; Reveal makes the secret and shows it once, in the view only, and Rotate replaces it. Secrets never reach the model or the chat history |

**Sign-in options (env):**
- Social login: `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- Company IdP via OIDC: `APP_MCP_OIDC_ISSUER`, `APP_MCP_OIDC_CLIENT_ID`, `APP_MCP_OIDC_CLIENT_SECRET`, `APP_MCP_OIDC_NAME`.
- `APP_MCP_PASSWORD_LOGIN=true`: email + password, for local dev and small installs.

**Other settings:**
- `APP_MCP_PUBLIC_URL`: the registry's public URL (Claude / ChatGPT must reach it; use a tunnel for local testing).
- `APP_MCP_AUTH_SECRET`: required in production.
- `APP_MCP_MODE`:
  - `self-hosted` (default): everyone who can sign in joins the workspace. The first person is admin, plus anyone listed in `APP_MCP_ADMIN_EMAILS`.
  - `hosted`: each new person gets a personal workspace.
- Invites: `member_invite`, from chat or the people view (`list_members`). Claimed at the person's next sign-in with that verified email, even if they already have a workspace (an unused one is deleted).
- `APP_MCP_ALLOWED_EMAILS`: sign-up gate, comma-separated emails and `@domain` entries. When set, only those verified emails get a workspace at first sign-in; anyone else is refused until invited. Existing members and invited people always get in.
- Client registration: Claude and ChatGPT use Client ID Metadata Documents. `APP_MCP_ALLOW_DCR=true` enables open dynamic registration, for local dev or DCR-only clients.

**Try it locally:** open `http://localhost:5173/?server=http://localhost:4000/mcp`. The playground runs the same OAuth flow a connector does: discovery → registration → sign-in → consent.

## Publish the npm packages

`@app-mcp/cli`, `@app-mcp/kit` and `@app-mcp/sdk` are what users install; they depend on `@app-mcp/format`, `@app-mcp/runtime` and `@app-mcp/ui`, so all seven go out together, with the same version. `pnpm publish` turns `workspace:^` into real version ranges. Once, create the `app-mcp` organization on npmjs.com and `npm login`. Then, after bumping `version` in each `packages/*/package.json`:

```bash
pnpm publish:packages --dry-run
pnpm publish:packages
```

The command builds, checks formatting/lint/types, runs tests, then publishes all seven npm packages in dependency order. It verifies that they share one version. Actual publishing requires a clean `master` in the main checkout; dry runs also work with local edits or from a worktree. Bump and commit the package versions before publishing. The script does not bump versions automatically or publish the Python SDK to PyPI. Run `npm login` first if needed.

To try a release without publishing, `pnpm pack` each package and point a test project at the tarballs (`file:` dependencies plus `overrides` for the internal ones).

## Use the SDK

app-mcp's tools (`render_form`, `render_chart`, `render_<component>`) and workflow prompts are served by app-mcp's end-user MCP. It's public by default: anyone with its address can add it as a connector, with no data tools. An admin can make it private (`public_set`, or ask in chat); then only servers with a server token can use it. The SDK puts them on your MCP server, next to your own tools, and forwards their calls to app-mcp with a server token. app-mcp's views call your tools through the host, so your data tools and their results never leave your server.

```ts
import { connectAppMcp, mountAppMcp } from "@app-mcp/sdk";

// Once per process: lists app-mcp's tools and prompts in the background. The URL picks the
// environment: /w/<workspace>/mcp for prod, /w/<workspace>/<environment>/mcp for the others.
const appMcp = connectAppMcp({ url: process.env.APP_MCP_MCP_URL, token: SERVER_TOKEN });

// Per server instance:
await mountAppMcp(server, {
  appMcp,
  watch: true, // long-lived servers: re-sync tools and send list_changed after a publish or save
});
```

Each deployment of your server (dev, staging, prod) points `APP_MCP_MCP_URL` at its environment. To serve two environments from one process (staff on staging, say), connect twice and pass the right client per request.

**Picking up changes.** Every publish, theme, instructions or workflow change bumps the environment's revision. When app-mcp's tools are used and the SDK's copy is older than `refreshSeconds` (default 60), it checks the revision in the background and re-lists only if it changed; a host never waits on it. To serve changes right away, mount the SDK's refresh endpoint and register its URL. app-mcp then calls it on every change:

```ts
import { refreshHandler } from "@app-mcp/sdk";

app.post("/app-mcp/refresh", (c) => refreshHandler(appMcp)(c.req.raw)); // Hono; any (Request) => Response framework
// Express: app.post("/app-mcp/refresh", (req, res) => { void appMcp.refresh(req.body?.revision); res.sendStatus(202); });
```

```bash
app-mcp env set prod --refresh-url https://mcp.acme.com/app-mcp/refresh   # "" clears it; app-mcp env list shows the last call
```

The call carries only the environment and its revision, and reaches one instance behind your load balancer; the others catch up at their next check. In app-mcp's cloud the URL must be public https.

Python: `app_mcp = connect_app_mcp(url, token)`, then `mount_app_mcp(server, app_mcp)`. See [packages/sdk-python](packages/sdk-python/README.md).

- **Fast, not offline.** `tools/list` is answered from memory, and `ui://` resources are content-hashed, so each is fetched once. Calls always go to app-mcp. When app-mcp is down, they return "app-mcp is unavailable right now, try again shortly.", and the model tells the user.
- **Cloud or self-hosted.** In app-mcp's cloud, app-mcp sees what the model passes to its tools (form specs, pre-filled values, inline chart rows), never your own tool calls or results. If that matters, run the app-mcp server yourself: it's the same image.

- **Submit tools** return `{ ok: true, message?, result? }` or `{ ok: false, fieldErrors?, formError? }` in `structuredContent`.
- **Answered once:** give a submit tool an idempotency-key parameter (e.g. `request_id`) and name it in `submit.idempotencyParam`. Forms pass one id per rendered form, so a repeated submit (another device, a view closed mid-submit) can return the first result. Forms keep their draft and their submitted state per render; `persistDraft: false` keeps answers out of storage for sensitive forms.
- **Source tools** return any JSON. The model maps it with `itemsPath` / `idPath` / `labelPath` (selects) or `x` / `series` (charts).
