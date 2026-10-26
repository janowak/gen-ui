# `genui serve` plan

A local genui MCP for developers: one command, no registry, workspace, account, token or database. Add it to Claude Code, Claude Desktop, the playground or your own server and see forms, charts, recipes and your components working.

**Status (2026-10-26)**
- Built: steps 1–8. Step 9 checked with MCP clients, not yet in Claude Desktop or Claude Code themselves (see "Checked" below).
- **Code:**
  - `@genui/runtime`: `mountGenUI` returns `{ remove() }` and serves old versions through `CatalogSource.bundle`.
  - `@genui/runtime/local`: `readComponentDir` (also used by `genui publish`) and `localCatalog`.
  - `@genui/runtime/serve`: `startServe`, `createLocalMcp` and `watchPaths`.
  - `@genui/kit/dev`: `watchBuild`.
  - The CLI: `genui serve`.
- **Differs from this plan:**
  - Two directories with the same component name don't stop the server: the second is reported and skipped, like any other problem.
  - `--guide <file>` serves the MCP's instructions and workflow prompts. Instructions only update when a client reconnects, because they're part of the server's initialize response.
  - Remounting is debounced (`debouncedNotificationMethods`): one `list_changed` per kind instead of one per tool.
  - Recipe `validate` webhooks (§6) aren't called locally. Direct clients get the values back in the conversation; SDK clients use the recipe's own submit tool.
  - The runtime keeps `node:crypto`: the Worker runs with `nodejs_compat`.
- **Checked:**
  - 25 runtime tests: catalog, both modes, `/revision` and its ETag, live reload with `list_changed`, the Host check, unbuilt components.
  - Manually:
    - `genui serve examples/rating --recipes examples/recipes` over HTTP. Editing `component.ts` rebuilt it and the connected client got the new URI.
    - The demo through `@genui/sdk` with token `local`: data tools on.
    - `--stdio` from an MCP client: stdout stays clean while Vite builds.
- **Left:**
  - Try it in Claude Code and Claude Desktop, and record which hosts re-list on `list_changed`.
  - `@genui/ui` ships the management views too (about 1 MB packed); `serve` only needs form and chart.

**Principle: same runtime, different source.** `serve` and the registry's end-user MCP run the same `mountGenUI`. The only difference is where the catalog comes from: the registry reads its database, `serve` reads files on disk. Moving from `serve` to staging or prod only changes the URL and token.

---

## 1. The gap

| Who | Wants | Today |
|---|---|---|
| Evaluating genui | See a form or chart in Claude | Registry, admin token, server token, demo with `.env.local`, playground: five steps and a workspace |
| Component author | See the component in a real host | `genui dev` is a fake host for one component: no MCP, so no Claude |
| Company integrating the SDK | Their own MCP server with genui tools, locally | Same five steps as above |

## 2. Shape

```bash
npx genui serve                                  # built-in form, chart; component in . if there is one
npx genui serve examples/rating ../acme/widgets  # plus these components, rebuilt and reloaded on save
npx genui serve --theme theme.json --recipes recipes/
npx genui serve --stdio                          # for Claude Desktop / Claude Code command connectors
```

```
genui serve on http://localhost:4100
  MCP:        http://localhost:4100/mcp
  Claude Code: claude mcp add --transport http genui http://localhost:4100/mcp
  SDK:        connectGenUI({ url: "http://localhost:4100/mcp", token: "local" })
  serving:    render_form, render_chart, render_rating (rating@1.2.0), use_recipe (1 recipe)
```

| Flag | What |
|---|---|
| `[dirs…]` | Component directories. Default `.` when it has a manifest or a `genui()` Vite config, else none |
| `--theme <file>` | Theme JSON (`Theme` from `@genui/format`) |
| `--recipes <path>` | A recipe JSON file, or a directory of them |
| `--port <n>` | Default 4100 |
| `--stdio` | Serve over stdio instead of HTTP. All output goes to stderr |
| `--suffix <name>` | Add `_<name>` to tool and prompt names, so a local connector can sit next to prod's in the same chat. Default: none, so tool names match prod |
| `--no-build` | Don't run each component's watch build; read `dist/` as it is |

**Out of scope:** auth, workspaces, environments, publishing, the management MCP and its views, webhooks for recipe `validate` (§6).

## 3. Package: `@genui/runtime`

Move the end-user runtime out of `apps/registry` so both servers import it.

| From `apps/registry/src` | To `packages/runtime/src` |
|---|---|
| `runtime.ts` (`mountGenUI`, `CatalogSource`, `Snapshot`) | `runtime.ts` |
| `views.ts` (`ViewBundle`, `bundle`, `contentHash`, `builtInViews`) | `views.ts`. `Assets` and the management views stay in the registry |
| `runtime.test.ts` | `runtime.test.ts` |
| The `ui://genui/c/{name}/{hash}` resource template in `hosted.ts` | `mountGenUI`, behind `CatalogSource.bundle?(hash)`, so `serve` gets old versions too |
| Manifest + bundle lookup in `cli.ts` `publish()` | `local.ts` `readComponentDir(dir)`, used by `publish` and `serve` |

- The root export (`@genui/runtime`) stays Worker-safe: no `node:fs`, `crypto.randomUUID()` from `globalThis`, assets passed in. The registry's Worker build imports it unchanged.
- `@genui/runtime/serve` is Node-only: the local source, watcher and HTTP/stdio servers.
- `mountGenUI` returns `{ remove() }`: every tool, resource and prompt handle it registered (they all have `remove()` in `@modelcontextprotocol/server` 2.3). `serve` uses it to remount on change (§5).
- `@genui/ui`: move the view build's dependencies (React, Base UI, Recharts, …) to `devDependencies`. The published package is only `dist/*.html`, so `npx genui` doesn't install a UI toolkit.
- `@genui/cli` depends on `@genui/runtime`. `serve` imports `@genui/runtime/serve` lazily, so registry commands stay fast.

## 4. Local catalog source

`localCatalog({ dirs, theme, recipes })` implements `CatalogSource` from files:

- **Components:** `readComponentDir(dir)`, the same rules as `publish`: a hand-written `genui.component.json` next to the sources, else `dist/genui.component.json` from `@genui/kit/vite`; the bundle path from `bundle` in the manifest, default `dist/index.html`. The manifest is validated with `ComponentManifest`, and the hash is `contentHash(html)` as in the registry.
- **Theme, recipes:** parsed with `Theme` and `Recipe`. A recipe directory loads every `*.json` in it.
- **Snapshot:** `{ catalog: { environment: "prod", theme, components, recipes }, bundles }`, rebuilt only on change.
- **Bundles by hash:** every bundle seen since start stays in memory, so a message rendered before a rebuild still loads its own version. A restart forgets them; that's fine locally.
- **Errors don't stop the server.** A directory that doesn't load (no build yet, invalid manifest, bundle too big) is logged with its reason and skipped. The next change retries it. Two directories with the same component name fail at start.
- **Revision:** a counter, bumped on every snapshot change.

## 5. Live reload

1. **Build.** For a directory with a `genui()` Vite config, `serve` runs its watch build (`watchBuild(root)`, a new export from `@genui/kit`, loaded from the component directory like `genui dev` loads `startDev`). `--no-build` skips this, e.g. for hand-built bundles or a build the developer runs themselves.
2. **Watch.** `fs.watch` on each manifest and bundle, the theme file and the recipes path, debounced 100 ms. On change: reload what changed, bump the revision, log `rating@1.2.1 reloaded (a1b2c3d4)` or the error.
3. **Push to connected clients.** Each session keeps its server; on change, `mounted.remove()`, `mountGenUI` again, `sendToolListChanged()` and `sendPromptListChanged()`. Hosts that honour `list_changed` see the new tools without reconnecting; the rest pick them up on their next list.
4. **No stale views.** A rebuilt component has a new content hash, so a new `ui://genui/c/<name>/<hash>` URI. Hosts that cache resources by URI fetch the new HTML.
5. **The SDK.** `GET /revision` returns `{ revision }` with an ETag, as the registry does, so `connectGenUI` re-lists after its next check (`refreshSeconds`). `--refresh-url <url>` also POSTs `{ environment, revision }` there on each change, so a server using `refreshHandler` picks up changes right away.

## 6. Transports and data tools

| | Direct (Claude → `serve`) | Through the SDK (Claude → your server → `serve`) |
|---|---|---|
| How it's picked | No `Authorization` header | Any bearer token (`token: "local"`); never checked |
| Data tools | Off: specs that call tools are rejected with the same message as the public MCP; recipe forms send values to the conversation | On: views call your server's tools |
| Same as | Public end-user MCP | Upstream with a server token |

- **HTTP:** `/mcp`, streamable HTTP with sessions (needed to push `list_changed`), CORS `*` for the playground and the MCP Inspector. Binds to `127.0.0.1` by default; `--host 0.0.0.0` for a tunnel.
- **stdio:** one session, direct mode. Logs go to stderr only, since stdout carries the protocol.
- **Recipe `validate`:** the registry posts to the recipe's webhook. `serve` does the same when the recipe JSON sets one (no signing secret locally), else it accepts the values as they are and logs them.

## 7. Docs and the repo

- **README "Run locally":** lead with `npx genui serve` and `claude mcp add`. The full registry setup moves under "Self-host".
- **Demo:** `GENUI_MCP_URL` defaults to `http://localhost:4100/mcp` with token `local`, so `genui serve` plus `pnpm --filter @genui/demo start` is the whole local stack.
- **`.claude/launch.json`:** add a `serve` configuration on port 4100 (`examples/rating`, `examples/recipes`).
- **Python SDK:** same URL and `"local"` token. No code change.
- **Landing page:** a "Try it" section: `npx genui serve` and the Claude Code command.

## 8. Steps

1. Extract `@genui/runtime`: move files, `mountGenUI` returns `{ remove() }`, resource template behind `bundle(hash)`, registry imports it. Registry tests pass unchanged.
2. `readComponentDir` in the runtime; `publish` uses it.
3. `localCatalog` with tests: directories, theme, recipes, broken directory skipped, duplicate names, old hashes kept.
4. `serve` over HTTP: sessions, direct vs SDK mode, `/revision`, CORS. Test with `@modelcontextprotocol/client`: list, call, read a resource, both modes.
5. Watch and remount: test that a changed bundle produces a new URI and a `list_changed` notification.
6. `--stdio`, then `watchBuild` in `@genui/kit` and `--no-build`.
7. `@genui/ui` dependencies to devDependencies; check `npm pack` sizes for `@genui/cli`.
8. README, demo default, launch config.
9. Manual check: Claude Code over HTTP, Claude Desktop over stdio, playground, demo through the SDK. Edit `examples/rating`, see the new version without reconnecting.

## 9. Open questions

- **SDK mode by token.** Any bearer token turning data tools on mirrors the registry, but `token: "local"` is a placeholder people have to type. The alternative is making `token` optional in the SDK and choosing the mode by MCP `clientInfo` (`genui-sdk`). That's more magic for little gain; keeping the token is proposed.
- **`list_changed` in real hosts.** Which hosts re-list on the notification (Claude Code, Claude Desktop, ChatGPT dev mode) is unverified. Step 9 records it in the README. Hosts that don't need a reconnect after adding a component; a rebuilt existing component works either way.
- **Default port.** 4100, next to the registry's 4000. `serve` and the registry can run at once.
