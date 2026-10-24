# genui-sdk (Python)

genui for Python MCP servers. `mount_genui` puts genui's tools (`render_form`, `render_chart`, `use_recipe` and your registry components as `render_<name>`), their `ui://` views and the recipe prompts on an `MCPServer` from the official [`mcp`](https://pypi.org/project/mcp/) SDK (2.3+). Each tool is shown as an MCP App inside the AI client.

The tools are served by genui's end-user MCP, in genui's cloud or your self-hosted genui server. This package forwards their calls there with a server token. genui's views call your own tools through the host, so your data tools and their results never leave your server. It works the same as `@genui/sdk` for Node.

```python
from mcp.server.mcpserver import MCPServer
from genui import connect_genui, mount_genui

genui = connect_genui(url="https://<genui>/w/<workspace>/mcp", token="...")  # once per process

server = MCPServer("acme")

@server.tool(description="Search customers by name. Returns { items: [{ id, name }] }.")
async def search_customers(query: str | None = None) -> dict: ...

@server.tool(description="Create an order. Returns { ok, message } or { ok: false, fieldErrors }.")
async def create_order(customer: str, notes: str | None = None) -> dict: ...

mount_genui(server, genui)
server.run("streamable-http")
```

The model can now call `render_form` with a field whose options come from `search_customers`, and a `submit` that calls `create_order`.

## Options

`connect_genui(url, token, refresh_seconds=60, timeout=10)`:

| Option | |
|---|---|
| `url` | The workspace's end-user MCP. The URL picks the environment: `<genui>/w/<workspace id>/mcp` for prod, `<genui>/w/<workspace id>/<environment>/mcp` for another environment (dev, staging, ...). |
| `token` | A workspace server token: `genui token server <name>`. |
| `refresh_seconds` | When genui's tools are used and the copy is older than this, the revision is checked in the background, and the tools re-listed only if it changed. `0` checks only on `refresh()`. |
| `timeout` | Per-request timeout in seconds. |

One client serves one environment. A process that serves two environments calls `connect_genui` twice.

`mount_genui(server, genui, watch=False, bus=None)`:

| Option | |
|---|---|
| `watch` | For long-lived servers: re-sync when genui's tools change (a publish, a recipe or theme save), and tell clients with `list_changed`. |
| `bus` | The `SubscriptionBus` you passed to `MCPServer(subscriptions=...)`, used for `watch` notifications to 2026-07-28 clients. |

`mount_genui` is synchronous. It waits for the first listing, so call it before `server.run()`.

`refresh_endpoint(genui)`: a Starlette endpoint genui calls after every publish, theme or recipe change, so your server serves it right away instead of at its next check. It answers 202 and refreshes in the background.

```python
from genui import refresh_endpoint

server.custom_route("/genui/refresh", methods=["POST"])(refresh_endpoint(genui))
```

Register its URL: `genui env set prod --refresh-url https://mcp.acme.com/genui/refresh`.

## How it works

- **Listing:** genui's tools and prompts are listed on a daemon thread and kept in memory, so `tools/list` on your server costs no round trip to genui. `ui://` resources are content-hashed, so each one is fetched once.
- **Changes:** every change to what an environment serves bumps its revision. A check is one small request to `.../revision` next to the MCP URL; the tools are re-listed only when it changed. Checks run in the background when genui's tools are used (at most every `refresh_seconds`) and when genui calls your refresh endpoint.
- **Calls:** every call goes to genui. When genui is down, a call returns "genui is unavailable right now, try again shortly." There is no cache file: nothing renders while genui is down.
- **Schemas:** tools keep genui's JSON Schemas. `MCPServer` has no public way to give `add_tool` a JSON Schema, so `mount_genui` registers each tool with `add_tool` and then sets the registered tool's `parameters`, through `server._tool_manager`. genui validates the arguments.
- **Old messages:** `MCPServer` has no `remove_resource`, so replaced `ui://` resources stay listed. They and any earlier component version (`ui://genui/c/<name>/<hash>`) are read from genui.
- **Notifications:** in watch mode, `list_changed` reaches clients in two ways. 2025-11-25 (handshake) clients get it on their connection, which is tracked from `initialize`. 2026-07-28 clients get it through `subscriptions/listen`. Pass `bus=` if your server runs replicas behind a shared bus.
- **What genui sees:** in genui's cloud, genui sees what the model passes to its tools (form specs, pre-filled values, inline chart rows), never your own tool calls or results. If that matters, self-host genui.

## Development

```bash
uv run pytest
```

The tests mirror `packages/sdk/src/mount.test.ts`. They run against an in-process fake of genui's end-user MCP.

## Example

`examples/demo_server.py` is `apps/demo` in Python: the same mock company tools plus `mount_genui`, on port 3002.

```bash
GENUI_MCP_URL=http://localhost:4000/w/<workspace id>/mcp GENUI_MCP_TOKEN=<server token> uv run python examples/demo_server.py
```

Open the playground against it at `http://localhost:5173/?server=http://localhost:3002/mcp`. For another environment, point `GENUI_MCP_URL` at `http://localhost:4000/w/<workspace id>/<environment>/mcp`.
