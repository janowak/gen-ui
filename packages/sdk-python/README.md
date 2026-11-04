# app-mcp-sdk (Python)

app-mcp for Python MCP servers. `mount_app_mcp` puts app-mcp's tools (`render_form`, `render_chart` and your registry components as `render_<name>`), their `ui://` views and the workflow prompts on an `MCPServer` from the official [`mcp`](https://pypi.org/project/mcp/) SDK (2.3+). Each tool is shown as an MCP App inside the AI client.

The tools are served by app-mcp's end-user MCP, in app-mcp's cloud or your self-hosted app-mcp server. This package forwards their calls there with a server token. app-mcp's views call your own tools through the host, so your data tools and their results never leave your server. It works the same as `@app-mcp/sdk` for Node.

```python
from mcp.server.mcpserver import MCPServer
from app_mcp import connect_app_mcp, mount_app_mcp

app_mcp = connect_app_mcp(url="https://<app-mcp>/w/<workspace>/mcp", token="...")  # once per process

server = MCPServer("acme")

@server.tool(description="Search customers by name. Returns { items: [{ id, name }] }.")
async def search_customers(query: str | None = None) -> dict: ...

@server.tool(description="Create an order. Returns { ok, message } or { ok: false, fieldErrors }.")
async def create_order(customer: str, notes: str | None = None) -> dict: ...

mount_app_mcp(server, app_mcp)
server.run("streamable-http")
```

The model can now call `render_form` with a field whose options come from `search_customers`, and a `submit` that calls `create_order`.

## Options

`connect_app_mcp(url, token, refresh_seconds=60, timeout=10)`:

| Option | |
|---|---|
| `url` | The workspace's end-user MCP. The URL picks the environment: `<app-mcp>/w/<workspace id>/mcp` for prod, `<app-mcp>/w/<workspace id>/<environment>/mcp` for another environment (dev, staging, ...). |
| `token` | A workspace server token: `app-mcp token server <name>`. |
| `refresh_seconds` | When app-mcp's tools are used and the copy is older than this, the revision is checked in the background, and the tools re-listed only if it changed. `0` checks only on `refresh()`. |
| `timeout` | Per-request timeout in seconds. |

One client serves one environment. A process that serves two environments calls `connect_app_mcp` twice.

`mount_app_mcp(server, app_mcp, watch=False, bus=None)`:

| Option | |
|---|---|
| `watch` | For long-lived servers: re-sync when app-mcp's tools change (a publish, a theme, instructions or workflow save), and tell clients with `list_changed`. |
| `bus` | The `SubscriptionBus` you passed to `MCPServer(subscriptions=...)`, used for `watch` notifications to 2026-07-28 clients. |

`mount_app_mcp` is synchronous. It waits for the first listing, so call it before `server.run()`.

`refresh_endpoint(app_mcp)`: a Starlette endpoint app-mcp calls after every publish, theme, instructions or workflow change, so your server serves it right away instead of at its next check. It answers 202 and refreshes in the background.

```python
from app_mcp import refresh_endpoint

server.custom_route("/app-mcp/refresh", methods=["POST"])(refresh_endpoint(app_mcp))
```

Register its URL: `app-mcp env set prod --refresh-url https://mcp.acme.com/app-mcp/refresh`.

## How it works

- **Listing:** app-mcp's tools and prompts are listed on a daemon thread and kept in memory, so `tools/list` on your server costs no round trip to app-mcp. `ui://` resources are content-hashed, so each one is fetched once.
- **Changes:** every change to what an environment serves bumps its revision. A check is one small request to `.../revision` next to the MCP URL; the tools are re-listed only when it changed. Checks run in the background when app-mcp's tools are used (at most every `refresh_seconds`) and when app-mcp calls your refresh endpoint.
- **Calls:** every call goes to app-mcp. When app-mcp is down, a call returns "app-mcp is unavailable right now, try again shortly." There is no cache file: nothing renders while app-mcp is down.
- **Schemas:** tools keep app-mcp's JSON Schemas. `MCPServer` has no public way to give `add_tool` a JSON Schema, so `mount_app_mcp` registers each tool with `add_tool` and then sets the registered tool's `parameters`, through `server._tool_manager`. app-mcp validates the arguments.
- **Old messages:** `MCPServer` has no `remove_resource`, so replaced `ui://` resources stay listed. They and any earlier component version (`ui://app-mcp/c/<name>/<hash>`) are read from app_mcp.
- **Notifications:** in watch mode, `list_changed` reaches clients in two ways. 2025-11-25 (handshake) clients get it on their connection, which is tracked from `initialize`. 2026-07-28 clients get it through `subscriptions/listen`. Pass `bus=` if your server runs replicas behind a shared bus.
- **What app-mcp sees:** in app-mcp's cloud, app-mcp sees what the model passes to its tools (form specs, pre-filled values, inline chart rows), never your own tool calls or results. If that matters, self-host app-mcp.

## Development

```bash
uv run pytest
```

The tests mirror `packages/sdk/src/mount.test.ts`. They run against an in-process fake of app-mcp's end-user MCP.

## Example

`examples/demo_server.py` is `apps/demo` in Python: the same mock company tools plus `mount_app_mcp`, on port 3002.

```bash
APP_MCP_MCP_URL=http://localhost:4000/w/<workspace id>/mcp APP_MCP_MCP_TOKEN=<server token> uv run python examples/demo_server.py
```

Open the playground against it at `http://localhost:5173/?server=http://localhost:3002/mcp`. For another environment, point `APP_MCP_MCP_URL` at `http://localhost:4000/w/<workspace id>/<environment>/mcp`.
