# genui-sdk (Python)

genui for Python MCP servers. `mount_genui` adds `render_form`, `render_chart`, `use_recipe` and your registry components to an `MCPServer` from the official [`mcp`](https://pypi.org/project/mcp/) SDK (2.3+). Each tool is shown as an MCP App inside the AI client.

This is the self-hosted variant: genui runs inside your own server, next to your data tools. Forms and charts call those tools through the host, so your data never passes through genui. The same views ship in `@genui/sdk` for Node.

```python
from mcp.server.mcpserver import MCPServer
from genui import create_registry_client, mount_genui

server = MCPServer("acme")

@server.tool(description="Search customers by name. Returns { items: [{ id, name }] }.")
async def search_customers(query: str | None = None) -> dict: ...

@server.tool(description="Create an order. Returns { ok, message } or { ok: false, fieldErrors }.")
async def create_order(customer: str, notes: str | None = None) -> dict: ...

mount_genui(
    server,
    registry=create_registry_client(url="https://registry.example.com", token="..."),  # optional
    channel="stable",
)
server.run("streamable-http")
```

The model can now call `render_form` with a field whose options come from `search_customers`, and a `submit` that calls `create_order`.

## Options

| Option | |
|---|---|
| `registry` | `create_registry_client(url, token, refresh_seconds=30, cache_file=None)`. Supplies custom components (`render_<name>`), recipes and the workspace theme. |
| `channel` | `"stable"` (default) or `"beta"`. |
| `theme` | A theme dict, or a function (sync or async) returning one. Overrides the registry's theme. |
| `recipes` | Recipe dicts for `use_recipe` and one prompt (slash command) each. Defaults to the registry's. |
| `watch` | For long-lived servers: re-sync components and recipes when the registry changes, and tell clients with `list_changed`. |
| `bus` | The `SubscriptionBus` you passed to `MCPServer(subscriptions=...)`, used for `watch` notifications to 2026-07-28 clients. |

`mount_genui` is synchronous. With a registry it waits for the first catalog load (or the cache file), so call it before `server.run()`. The registry client polls on a daemon thread and keeps the last good snapshot when the registry is down. Bundles are checked against their sha256 hash.

## How it maps to the Node SDK

- Same tools, descriptions, `ui://genui/...` resource URIs (content-hashed the same way) and `_meta` keys (`genui/viewId`, `genui/theme`, `genui/form`).
- Input schemas are not written by hand. `packages/format` exports them from zod at build time (`schemas/form.json`, `chart.json`, `recipe-input.json`), and this package ships those files with the view HTML.
- Not ported: `preview` and `dataTools`. They exist for the registry's hosted MCP, which runs in Node.
- When a component is updated, its old `ui://` resource stays readable, because `MCPServer` has no `remove_resource`. The tool always points to the current version.
- `MCPServer` has no public way to give `add_tool` a JSON Schema. `mount_genui` registers each tool with `add_tool`, then sets the registered tool's `parameters`. It reaches that tool through `server._tool_manager`, and checks arguments with `jsonschema`.
- In watch mode, `list_changed` reaches clients in two ways. 2025-11-25 (handshake) clients get it on their connection, which is tracked from `initialize`. 2026-07-28 clients get it through `subscriptions/listen`. Pass `bus=` if your server runs replicas behind a shared bus.

## Development

The view bundles and schemas are copied from the TypeScript build:

```bash
pnpm --filter @genui/format --filter @genui/ui build
```

```bash
uv run python scripts/sync_assets.py
```

```bash
uv run pytest
```

The tests mirror `packages/sdk/src/mount.test.ts` and `registry.test.ts`. They run against an in-process fake of the registry's `/v1/catalog` and `/v1/bundles` API.

## Example

`examples/demo_server.py` is `apps/demo` in Python: the same mock company tools plus `mount_genui`, on port 3002.

```bash
uv run python examples/demo_server.py
```

Open the playground against it at `http://localhost:5173/?server=http://localhost:3002/mcp`. To pull components from a registry, set `GENUI_REGISTRY_URL`, `GENUI_REGISTRY_TOKEN` and optionally `GENUI_CHANNEL`.
