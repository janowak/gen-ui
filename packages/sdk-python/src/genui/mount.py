"""`mount_genui`: puts genui's tools, `ui://` resources and workflow prompts on your MCPServer.

A port of `packages/sdk/src/mount.ts`. Calls are forwarded to genui; your own tools stay on your
server, where genui's views call them through the host.
"""

from __future__ import annotations

import asyncio
import json
import threading
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.prompts.base import Prompt as ServerPrompt
from mcp.server.mcpserver.prompts.base import PromptArgument
from mcp.server.mcpserver.resources import FunctionResource
from mcp.server.subscriptions import PromptsListChanged, ResourcesListChanged, SubscriptionBus, ToolsListChanged
from mcp.types import CallToolResult, Prompt, Tool

from .client import GenUIClient, resource_uri

RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"


class GenUIHandle:
    """What `mount_genui` returns."""

    def __init__(self, tools: Callable[[], list[str]], close: Callable[[], None]):
        self._tools = tools
        self._close = close

    def tools(self) -> list[str]:
        """genui tools currently on the server."""
        return self._tools()

    def close(self) -> None:
        """Stops watching genui."""
        self._close()


def _key(item: Tool | Prompt) -> str:
    return json.dumps(item.model_dump(mode="json"), sort_keys=True)


def _mirror(mounted: dict[str, str], wanted: list[Any], register: Callable[[Any], None], remove: Callable[[str], None]) -> bool:
    """Brings registered items in line with `wanted`, re-registering any whose definition changed. Returns True if anything changed."""
    by_name = {item.name: item for item in wanted}
    changed = False
    for name, key in list(mounted.items()):
        if name in by_name and _key(by_name[name]) == key:
            continue
        remove(name)
        del mounted[name]
        changed = True
    for name, item in by_name.items():
        if name in mounted:
            continue
        register(item)
        mounted[name] = _key(item)
        changed = True
    return changed


class _Notifier:
    """Sends tools/resources/prompts list_changed to every connected client, from any thread.

    Handshake-era (2025-11-25) clients get notifications on their connection; 2026-07-28 clients
    get them through `subscriptions/listen`, i.e. the server's subscription bus.
    """

    def __init__(self, server: MCPServer, bus: SubscriptionBus | None):
        self._server = server
        # MCPServer keeps the bus it builds private; pass `bus=` (the one given to MCPServer) to avoid relying on it.
        self._bus = bus if bus is not None else getattr(server, "_subscriptions", None)
        self._connections: weakref.WeakKeyDictionary[Any, asyncio.AbstractEventLoop] = weakref.WeakKeyDictionary()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def middleware(self, ctx: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:  # not asyncio: notifications are not supported
            return await call_next(ctx)
        result = await call_next(ctx)
        if ctx.method == "initialize":
            # One initialize per handshake-era connection. The request's session only exposes the
            # connection (whose standalone stream carries notifications) privately.
            connection = getattr(ctx.session, "_connection", None)
            if connection is not None:
                self._connections[connection] = self._loop
            # MCPServer advertises listChanged: false on handshake-era connections; this server does send them.
            capabilities = result.get("capabilities") if isinstance(result, dict) else None
            for kind in ("tools", "resources", "prompts"):
                if isinstance(capabilities, dict) and isinstance(capabilities.get(kind), dict):
                    capabilities[kind]["listChanged"] = True
        return result

    def notify(self, tools: bool, prompts: bool) -> None:
        """Schedules the notifications on the server's event loop. Safe to call from any thread."""
        for connection, loop in list(self._connections.items()):
            self._schedule(loop, self._send_connection(connection, tools, prompts))
        if self._loop is not None and self._bus is not None:
            self._schedule(self._loop, self._publish(tools, prompts))

    @staticmethod
    def _schedule(loop: asyncio.AbstractEventLoop, coroutine: Awaitable[None]) -> None:
        if loop.is_closed():
            coroutine.close()  # type: ignore[attr-defined]
            return
        asyncio.run_coroutine_threadsafe(coroutine, loop)  # type: ignore[arg-type]

    @staticmethod
    async def _send_connection(connection: Any, tools: bool, prompts: bool) -> None:
        # Connection.notify drops messages for closed streams instead of raising.
        if tools:
            await connection.send_tool_list_changed()
            await connection.send_resource_list_changed()
        if prompts:
            await connection.send_prompt_list_changed()

    async def _publish(self, tools: bool, prompts: bool) -> None:
        assert self._bus is not None
        if tools:
            await self._bus.publish(ToolsListChanged())
            await self._bus.publish(ResourcesListChanged())
        if prompts:
            await self._bus.publish(PromptsListChanged())


def mount_genui(
    server: MCPServer,
    genui: GenUIClient,
    *,
    watch: bool = False,
    bus: SubscriptionBus | None = None,
) -> GenUIHandle:
    """Puts genui's tools (render_form, render_chart, render_<component>), their `ui://`
    resources and the workflow prompts on your server, next to your own tools.

    Args:
        server: The MCPServer that also serves your data and submit tools.
        genui: From `connect_genui`, once per process. Its URL picks the environment this server serves.
        watch: Re-sync when genui's tools change (on a publish or a theme, instructions or workflow save) and notify clients (list_changed).
        bus: The SubscriptionBus passed to MCPServer(subscriptions=...), used for watch notifications to
            2026-07-28 clients. Defaults to the server's own bus.
    """
    genui.ready()
    tools: dict[str, str] = {}
    prompts: dict[str, str] = {}
    resources: set[str] = set()
    lock = threading.RLock()

    def add_tool(tool: Tool) -> None:
        # MCPServer derives input schemas from function signatures and has no public way to pass a JSON
        # Schema to add_tool; the registered Tool's `parameters` is the schema tools/list advertises.
        async def call(ctx: Context) -> CallToolResult:
            params = ctx.request_context.params or {}
            arguments = params.get("arguments")
            return await genui.call_tool(tool.name, dict(arguments) if isinstance(arguments, dict) else {})

        server.add_tool(
            call,
            name=tool.name,
            title=tool.title,
            description=tool.description,
            annotations=tool.annotations,
            meta=tool.meta,
            structured_output=False,
        )
        registered = server._tool_manager.get_tool(tool.name)
        assert registered is not None
        registered.parameters = tool.input_schema

    def add_prompt(prompt: Prompt) -> None:
        async def forward(**arguments: Any) -> list[dict[str, Any]]:
            values = {name: str(value) for name, value in arguments.items() if value is not None}
            result = await genui.get_prompt(prompt.name, values)
            return [message.model_dump(mode="json", by_alias=True, exclude_none=True) for message in result.messages]

        server.add_prompt(
            ServerPrompt(
                name=prompt.name,
                title=prompt.title,
                description=prompt.description,
                arguments=[PromptArgument(name=a.name, description=a.description, required=a.required) for a in prompt.arguments or []],
                fn=forward,
            )
        )

    async def read(uri: str) -> str:
        content = (await genui.read_resource(uri)).contents[0]
        return getattr(content, "text", "")

    def add_resource(uri: str) -> None:
        # MCPServer has no remove_resource: earlier versions stay listed, read from genui when asked for.
        if uri in resources:
            return
        resources.add(uri)
        cached = genui.resource(uri)
        mime_type = cached.contents[0].mime_type if cached and cached.contents else None

        async def load() -> str:
            return await read(uri)

        server.add_resource(FunctionResource(uri=uri, name=uri, mime_type=mime_type or RESOURCE_MIME_TYPE, fn=load))

    # Earlier component versions, for old messages the host renders again: read from genui.
    @server.resource("ui://genui/c/{name}/{digest}", name="genui component version", mime_type=RESOURCE_MIME_TYPE)
    async def component_version(name: str, digest: str) -> str:
        return await read(f"ui://genui/c/{name}/{digest}")

    def sync() -> tuple[bool, bool]:
        """Returns whether tools and prompts changed."""
        snapshot = genui.snapshot()
        if snapshot is None:
            return False, False
        tools_changed = _mirror(tools, snapshot.tools, add_tool, server.remove_tool)
        prompts_changed = _mirror(prompts, snapshot.prompts, add_prompt, server.remove_prompt)
        for tool in snapshot.tools:
            uri = resource_uri(tool)
            if uri:
                add_resource(uri)
        return tools_changed, prompts_changed

    with lock:
        sync()

    cleanup: list[Callable[[], None]] = []
    if watch:
        notifier = _Notifier(server, bus)
        server.middleware.append(notifier.middleware)
        cleanup.append(lambda: server.middleware.remove(notifier.middleware))

        def on_change() -> None:
            with lock:
                tools_changed, prompts_changed = sync()
            if tools_changed or prompts_changed:
                notifier.notify(tools=tools_changed, prompts=prompts_changed)

        cleanup.append(genui.on_change(on_change))

    def close() -> None:
        while cleanup:
            cleanup.pop()()

    return GenUIHandle(tools=lambda: list(tools), close=close)


__all__ = ["GenUIHandle", "mount_genui"]
