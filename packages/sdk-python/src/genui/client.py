"""genui client: lists genui's tools and prompts, and forwards calls to genui's end-user MCP.

A port of `packages/sdk/src/client.ts`. Listing runs on a daemon thread with its own event loop,
so the client works the same under `server.run()`, an ASGI server or an async main. Calls run on
the caller's event loop.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.types import CallToolResult, GetPromptResult, Prompt, ReadResourceResult, TextContent, Tool

UNAVAILABLE_TEXT = "genui is unavailable right now, try again shortly."

Listener = Callable[[], None]
ClientFactory = Callable[[], Client]


@dataclass(frozen=True)
class Snapshot:
    """What genui offers: the tools and prompts to mirror onto your server."""

    tools: list[Tool]
    prompts: list[Prompt]

    def key(self) -> list[Any]:
        return [[t.model_dump(mode="json") for t in self.tools], [p.model_dump(mode="json") for p in self.prompts]]


def resource_uri(tool: Tool) -> str | None:
    """`ui://` resource a tool renders into (MCP Apps)."""
    ui = (tool.meta or {}).get("ui")
    uri = ui.get("resourceUri") if isinstance(ui, dict) else None
    return uri if isinstance(uri, str) else None


class GenUIClient:
    """Use `connect_genui`. Tools and prompts are kept in memory; `ui://` resources are fetched once."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        refresh_seconds: float = 30,
        timeout: float = 10,
        client_factory: ClientFactory | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._url = url
        self._token = token
        self._timeout = timeout
        self._client_factory = client_factory
        self._logger = logger or logging.getLogger("genui")
        self._snapshot: Snapshot | None = None
        self._resources: dict[str, ReadResourceResult] = {}
        self._listeners: list[Listener] = []
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._interval = refresh_seconds
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, name="genui", daemon=True)
        self._thread.start()

    def ready(self, timeout: float | None = None) -> bool:
        """Blocks until the first load attempt finished, successful or not."""
        return self._ready.wait(timeout)

    def snapshot(self) -> Snapshot | None:
        """The current tools and prompts, or None if genui was never reached."""
        return self._snapshot

    def resource(self, uri: str) -> ReadResourceResult | None:
        """A `ui://` resource a current tool points at."""
        return self._resources.get(uri)

    def refresh(self) -> None:
        """Re-lists genui's tools and prompts now. Listeners run on the client's thread."""
        asyncio.run_coroutine_threadsafe(self._refresh(), self._loop).result()

    async def read_resource(self, uri: str) -> ReadResourceResult:
        cached = self._resources.get(uri)
        if cached is not None:
            return cached
        async with self._session() as client:
            return await client.read_resource(uri)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        """Forwards a call to genui. When genui can't be reached, returns an error result the model can relay."""
        try:
            async with self._session() as client:
                return await client.call_tool(name, arguments)
        except MCPError:
            raise  # genui answered with an error: let it surface as the tool's error
        except Exception as error:
            self._logger.warning("[genui] %s failed, genui unreachable: %s", name, error)
            return CallToolResult(content=[TextContent(type="text", text=UNAVAILABLE_TEXT)], is_error=True)

    async def get_prompt(self, name: str, arguments: dict[str, str]) -> GetPromptResult:
        try:
            async with self._session() as client:
                return await client.get_prompt(name, arguments)
        except MCPError:
            raise
        except Exception as error:
            self._logger.warning("[genui] prompt %s failed, genui unreachable: %s", name, error)
            raise RuntimeError(UNAVAILABLE_TEXT) from error

    def on_change(self, listener: Listener) -> Callable[[], None]:
        """Calls `listener()` when genui's tools or prompts change. Returns an unsubscribe function."""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def close(self) -> None:
        """Stops listing."""
        self._closed.set()
        self._listeners.clear()

    def __enter__(self) -> GenUIClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[Client]:
        if self._client_factory is not None:
            async with self._client_factory() as client:
                yield client
            return
        headers = {"authorization": f"Bearer {self._token}"}
        async with httpx2.AsyncClient(headers=headers, timeout=self._timeout) as http:
            async with Client(streamable_http_client(self._url, http_client=http), read_timeout_seconds=self._timeout) as client:
                yield client

    async def _load(self) -> None:
        async with self._session() as client:
            tools = list((await client.list_tools()).tools)
            # No prompts capability until the environment has recipes.
            prompts = list((await client.list_prompts()).prompts) if client.server_capabilities.prompts else []
            for tool in tools:
                uri = resource_uri(tool)
                if uri and uri not in self._resources:
                    self._resources[uri] = await client.read_resource(uri)
        snapshot = Snapshot(tools=tools, prompts=prompts)
        if self._snapshot is not None and self._snapshot.key() == snapshot.key():
            return
        self._snapshot = snapshot
        for listener in list(self._listeners):
            listener()

    async def _refresh(self) -> None:
        try:
            await self._load()
        except Exception as error:  # keep serving the current tools
            self._logger.warning("[genui] could not list genui's tools, keeping the current ones: %s", error)
        # Keep only the resources current tools point at; old ones are read from genui when asked for.
        wanted = {resource_uri(t) for t in self._snapshot.tools} if self._snapshot else set()
        for uri in [u for u in self._resources if u not in wanted]:
            del self._resources[uri]

    async def _poll(self) -> None:
        try:
            await self._refresh()
        finally:
            self._ready.set()
        while self._interval > 0 and not self._closed.is_set():
            await asyncio.sleep(self._interval)
            if not self._closed.is_set():
                await self._refresh()

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.create_task(self._poll())
        self._loop.run_forever()


def connect_genui(
    url: str,
    token: str,
    *,
    refresh_seconds: float = 30,
    timeout: float = 10,
    client_factory: ClientFactory | None = None,
    logger: logging.Logger | None = None,
) -> GenUIClient:
    """Connects to one environment of genui's end-user MCP, once per process.

    The URL picks the environment. A process that serves two environments connects twice.

    Args:
        url: The workspace's end-user MCP, or your self-hosted genui: e.g. https://mcp.genui.example/w/<workspace>/mcp
            for prod, https://mcp.genui.example/w/<workspace>/<environment>/mcp for another environment.
        token: Workspace server token (scope: server).
        refresh_seconds: How often to re-list genui's tools and prompts. 0 disables polling.
        timeout: Per-request timeout in seconds.
        client_factory: Builds the MCP client, for tests (e.g. an in-process server).
    """
    return GenUIClient(url, token, refresh_seconds=refresh_seconds, timeout=timeout, client_factory=client_factory, logger=logger)
