# Environments plan

Replace the beta/stable release pipeline with environments that each workspace defines. genui becomes a runtime registry plus MCP server: CI publishes a version to an environment, and that environment serves it. No promote, no rollback, no rules between environments.

**Status (2026-10-24)**
- Decided (§8). Building.
- Replaces the release flow in V1-PLAN §5–6 (beta → stable, promote and rollback as admin tools).

**Principle: deterministic per environment.** What a connector serves depends only on its URL and what was last published or saved to that environment. Nothing moves an environment except a publish or a save that targets it.

---

## 1. What changes

| | Today | After |
|---|---|---|
| Targets | Two fixed channels, `beta` and `stable` | Environments per workspace. `prod` always exists; admins add others (`dev`, `staging`, …) |
| Publish | Lands on beta; `--channel stable` lands on both. Never moves a channel back | Points one environment at exactly the version published. The last publish wins, older versions included |
| Ordering | Beta is never behind stable; versions must increase | None. Environments are independent |
| Promote, rollback | `genui promote` / `rollback`, manager view buttons, `channel_history` | Removed. To go back, publish the older version again |
| Version rules | Immutable, increasing, major bump for breaking props | Immutable only: one version, one bundle. Breaking props is a warning |
| Recipes, theme | Workspace-wide, live on save | Per environment |
| Token scopes | `server`, `publish` (beta), `release` (stable, promote, rollback), `admin` | `server`, `publish`, `admin`. Publish tokens can be limited to environments |
| Tool names | The same on every channel | Suffixed outside prod: `render_form_staging` |
| SDKs | `channel` option, `x-genui-channel` header, the client lists every channel | The URL picks the environment. No channel concept in the SDKs |
| Switching | Another URL, or `x-genui-channel` per request | End users: another connector. Admins: `use_environment` for previews (§5) |

**Unchanged:** content-hashed bundles kept forever (old messages render the version they were made with), the end-user MCP, `watch` / `list_changed`, hosting.

**"Sync"** is read as channel coupling: a stable publish moving beta along, and publish only ever advancing pointers. Both go. The SDK's tool mirroring (`sync()` in `mount.ts`, `watch`) is runtime and stays.

---

## 2. Model

- **`environments`** `(workspace_id, name, theme, created_at)`, primary key `(workspace_id, name)`.
  - Names match `^[a-z][a-z0-9]{0,14}$`. Fifteen characters keep `render_<component>_<env>` within the 64 characters some hosts allow for tool names.
  - `createWorkspace` creates `prod`. `prod` can't be deleted.
  - Creating one is explicit (`genui env add staging`): a typo in `--env` fails instead of creating an environment.
- **`deployments`** `(component_id, environment, version_id)`, primary key `(component_id, environment)`: the version each environment serves. Replaces `channels`.
- **`recipes`** gain `environment`; primary key `(workspace_id, environment, name)`.
- **Theme** moves from `workspaces.theme` to `environments.theme`.
- **`tokens.environments`**: JSON list of environments a publish token may publish to; null means all.
- **`members.environment`**: the member's active environment in the management MCP; null means `prod` (§5).
- **`channel_history`** and `channels` are dropped. No data to keep: one migration drops and rebuilds; workspaces get `prod`, release tokens become publish tokens.
- **Deleting an environment** deletes its deployments and recipes. SDKs pointed at it get 404 and keep their last tools, as they do today when listing fails.
- **`@app-mcp/format`:** `CHANNELS` / `Channel` become `EnvironmentName` and `DEFAULT_ENVIRONMENT = "prod"`. `Catalog.channel` becomes `Catalog.environment`.

---

## 3. Publish

```
publish(workspace, manifest, html, environment = "prod")
  version exists, same bundle and manifest  → point the environment at it   (200)
  version exists, different content         → 409: versions are immutable
  new version                               → store it, point the environment at it (201)

deploy(workspace, name, version, environment)   # no bundle
  version exists → point the environment at it
  else           → 404
```

- No "must be greater than the latest", no "never moves back". Publishing 1.1.0 to prod after 1.2.0 is how you go back.
- `deploy` puts a version that's already published into another environment without rebuilding: builds aren't always byte-identical, and a different bundle under an existing version is a 409. CLI: `genui publish rating@1.2.0 --env prod`.
- A breaking props change (removed prop, newly required prop) compared with the version the environment served before comes back as `warnings`. The CLI prints them.
- The response lists every environment's version, so the CLI can print `Now prod=1.2.0 staging=1.3.0`.
- Publishing to an environment that doesn't exist fails with the command that creates it.

---

## 4. Surfaces

### Registry API (`/v1`)
- `POST /components` takes `{ manifest, html, environment? }`, default `prod`.
- `PUT /components/:name/environments/:environment` takes `{ version }`: deploy an existing version.
- Both need a publish token allowed in that environment, or an admin token.
- `POST /components/:name/promote` and `/rollback` are removed.
- `GET /components` returns `{ name, environments: { prod: "1.2.0", … }, versions }`.
- `GET /environments` (server) lists environments with their end-user MCP paths. `POST /environments { name }` and `DELETE /environments/:name` (admin).
- Recipes and theme take `?environment=` (default `prod`): `GET` / `PUT` / `DELETE /recipes/:name`, `GET` / `PUT /theme`.
- `POST /tokens { scope, name, environments? }`. `environments` only applies to publish tokens.
- `GET` / `PUT /hosting` return one path per environment.

### End-user MCP
- `/w/<id>/mcp` serves `prod`. `/w/<id>/<env>/mcp` serves that environment; `/w/<id>/prod/mcp` also works.
- The same paths serve server tokens (SDK) and public hosting. `/w/<id>/beta/mcp` and `x-genui-channel` are removed.
- An unknown environment is a 404.
- **Suffixed names outside prod.** Tools and prompts get `_<env>`: `render_form_staging`, `render_chart_staging`, `use_recipe_staging`, `render_rating_staging`, `genui_validate_staging`, `/create_order_staging`. Titles say "(staging)". Descriptions that name other tools use the suffixed names.
  - A staging connector can sit next to prod in one chat; the model can tell them apart, and testers see `_staging` on every call.
  - A view calls tools on the server that rendered it, so staging components still reach the staging server's tools.
  - Trade-off: staging isn't byte-for-byte prod. A system prompt that names `render_form` won't match on staging.

### SDKs (TypeScript and Python)
- `connectGenUI({ url, token })`. The URL includes the environment, so one client serves one environment.
- Removed: `Channel`, `CHANNELS`, the `channel` argument on `snapshot` / `readResource` / `callTool` / `getPrompt`, the per-channel connections, and `mountGenUI`'s `channel` option.
- A process that serves two environments creates two clients. The SDKs copy tool names as genui lists them, so suffixes need nothing here.
- Python mirrors it: `connect_genui(url, token)`, `mount_genui(server, genui)`.

### CLI
- `genui publish [dir] [--env name]`, env `GENUI_ENV`, default `prod`. `genui publish <name>@<version> --env name` deploys an existing version. `--channel` and `GENUI_CHANNEL` go.
- `promote` and `rollback` go.
- `genui list` prints `rating  prod=1.2.0  staging=1.3.0  (4 versions)`.
- New: `genui env list | add <name> | rm <name>` (admin).
- `genui token publish ci-preview --env dev,staging`.
- `genui theme` and `genui recipe` take `--env`.

### Management MCP
- `manage_components`: components by environment, read-only. `ManagerView` shows a column per environment, marks the active one, and switches it.
- The app-only `component_promote` and `component_rollback` tools are removed.
- New: `use_environment` (§5). Previews, theme and recipes follow the active environment.

### Runtime and the rest
- `mountGenUI`, `storeCatalog`, `createHostedMcp`: `channel` becomes `environment`, and the environment sets the suffix.
- `x-genui-channel` leaves the CORS header lists in `hosted.ts` and `management.ts`.
- Demo server: drops the per-request channel header; the environment comes from `GENUI_URL`. Playground: drops `?channel=`.

---

## 5. Switching environments

MCP has no sessions to hold an "active environment". The 2026-07-28 revision is stateless, and `createMcpHandler` serves 2025 clients statelessly too. So the choice has to be stored against someone genui can identify.

| Where | Who genui sees | How you switch |
|---|---|---|
| Management MCP (`/mcp`) | A signed-in member (OAuth) | `use_environment`, saved per member, default `prod` |
| End-user MCP behind the SDK | The company's server (server token), never the end user | The URL: the company's staging server as a second connector |
| Hosted end-user MCP | Anyone with the URL | The URL: `/w/<id>/staging/mcp` as a second connector |

### Management MCP: `use_environment`
- `use_environment { name }`. The model can call it ("show me staging"), and the `ManagerView` picker calls it. Any member may switch; it changes only what that person sees.
- Saved in `members.environment`, so it holds across conversations.
- `preview_<name>` renders the version the active environment serves. A component the environment doesn't have gets no preview tool. Theme and recipe views show and save the active environment's.
- A switch changes the preview tools, so the registry sends `tools_list_changed` (`handler.notify`, to every open `subscriptions/listen` stream). Hosts that don't re-list mid-chat show the new previews in the next chat, and the tool's reply says so.

### End-user MCP: no switch tool
- **genui can't tell end users apart.** Behind the SDK it sees one server token per company server, so a switch would move every user of that server at once.
- **Environments pair with the company's deployments.** Staging components call tools on the company's staging server.
- **Exposure.** Anyone in a prod chat, or a prompt injection, could move users onto unreleased UI. Gating that needs the permissions layer genui deliberately doesn't have.

To switch, add the staging server (or `/w/<id>/staging/mcp`) as a second connector. With suffixed names, both can stay on. A company that wants staff on staging inside one connector picks the client per request on its own server, where it knows the user:

```ts
const prod = connectGenUI({ url: `${GENUI}/w/${WS}/mcp`, token });
const staging = connectGenUI({ url: `${GENUI}/w/${WS}/staging/mcp`, token });
await mountGenUI(server, { genui: user.isStaff ? staging : prod });
```

---

## 6. Docs and site

- **README:** rewrite "Registry and release flow" around environments. The CI example keeps one GitHub environment per genui environment, with `GENUI_ENV` instead of `GENUI_CHANNEL`. SDK section: the URL picks the environment.
- **V1-PLAN:** §5 tools and roles, §6 "Promotion", and §9's `/w/<workspace>/beta/mcp` and "snapshot cache per workspace and channel".
- **Site:** remove the release lane; replace the promote/rollback copy with environments.
- **Python SDK README** and `demo_server.py`: drop `channel` and `GENUI_CHANNEL`.

---

## 7. Steps

1. **Store and API.** Format types, migration, store, API routes, `app.test.ts`.
2. **End-user and management MCP.** Paths, suffixes, management tools and views, `use_environment`. `hosted.test.ts`, `management.test.ts`, `runtime.test.ts`.
3. **SDKs.** TypeScript and Python, their tests, the demo server and the playground.
4. **CLI.**
5. **Docs and site.**

---

## 8. Decisions

1. **The same version in another environment:** `deploy` by reference (`genui publish rating@1.2.0 --env prod`).
2. **Who can publish to prod:** publish tokens can be limited to environments; unlimited by default.
3. **Version rules:** immutability only; breaking props is a warning.
4. **Recipes and theme:** per environment.
5. **Creating environments:** explicit.
6. **A switch on the end-user MCP:** none; the URL picks the environment.
7. **Tool names:** suffixed outside prod.

**Not in this change:** turning the suffix off for an environment (an exact prod rehearsal), removing a component from an environment, per-environment hosting or server tokens, prerelease versions (`1.3.0-rc.1`).
