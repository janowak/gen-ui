"""genui client: lists genui's tools and prompts, and forwards calls to genui's end-user MCP.

A port of `packages/sdk/src/client.ts`. Listing runs on a daemon thread with its own event loop,
so the client works the same under `server.run()`, an ASGI server or an async main. Calls run on
the caller's event loop.

The copy is checked in the background when it's used and older than `refresh_seconds`, and right
away when genui calls your refresh endpoint (`refresh_endpoint`).
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
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
RevisionSource = Callable[[], Awaitable[int]]

_MCP_PATH = re.compile(r"/mcp/?$")


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
        refresh_seconds: float = 60,
        timeout: float = 10,
        client_factory: ClientFactory | None = None,
        fetch_revision: RevisionSource | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._url = url
        self._token = token
        self._timeout = timeout
        self._client_factory = client_factory
        self._fetch_revision = fetch_revision
        # The environment's revision sits next to its MCP: .../mcp -> .../revision.
        self._revision_url = _MCP_PATH.sub("/revision", url) if _MCP_PATH.search(url) else None
        self._logger = logger or logging.getLogger("genui")
        self._snapshot: Snapshot | None = None
        self._revision: int | None = None
        self._checked_at = 0.0
        self._resources: dict[str, ReadResourceResult] = {}
        self._listeners: list[Listener] = []
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._interval = refresh_seconds
        # One check at a time; a refresh asked for during a check gets one more check after it.
        self._lock = asyncio.Lock()
        self._requested = 0
        self._completed = 0
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

    def revision(self) -> int | None:
        """The environment revision the current tools come from, or None before the first load."""
        return self._revision

    def refresh(self, at_least: int | None = None, *, wait: bool = True) -> None:
        """Checks genui's revision and re-lists its tools and prompts if it changed. Listeners run on the client's thread.

        Args:
            at_least: Do nothing when this client already has this revision.
            wait: False starts the check in the background and returns at once.
        """
        if at_least is not None and self._revision is not None and self._revision >= at_least:
            return
        future = asyncio.run_coroutine_threadsafe(self._refresh(), self._loop)
        if wait:
            future.result()

    async def read_resource(self, uri: str) -> ReadResourceResult:
        self._used()
        cached = self._resources.get(uri)
        if cached is not None:
            return cached
        async with self._session() as client:
            return await client.read_resource(uri)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        """Forwards a call to genui. When genui can't be reached, returns an error result the model can relay."""
        self._used()
        try:
            async with self._session() as client:
                return await client.call_tool(name, arguments)
        except MCPError:
            raise  # genui answered with an error: let it surface as the tool's error
        except Exception as error:
            self._logger.warning("[genui] %s failed, genui unreachable: %s", name, error)
            return CallToolResult(content=[TextContent(type="text", text=UNAVAILABLE_TEXT)], is_error=True)

    async def get_prompt(self, name: str, arguments: dict[str, str]) -> GetPromptResult:
        self._used()
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
            # No prompts capability until the environment has a workflow with params.
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

    async def _latest_revision(self) -> int | None:
        """genui's current revision of this environment; None when it can't be asked (no `/revision` next to the URL)."""
        if self._fetch_revision is not None:
            return await self._fetch_revision()
        if self._client_factory is not None or self._revision_url is None:
            return None
        headers = {"authorization": f"Bearer {self._token}"}
        async with httpx2.AsyncClient(headers=headers, timeout=self._timeout) as http:
            response = await http.get(self._revision_url)
            response.raise_for_status()
            return int(response.json()["revision"])

    async def _check(self) -> None:
        self._checked_at = time.monotonic()
        try:
            latest = await self._latest_revision()
            if self._snapshot is not None and latest is not None and latest == self._revision:
                return
            await self._load()
            self._revision = latest
        except Exception as error:  # keep serving the current tools
            self._logger.warning("[genui] could not list genui's tools, keeping the current ones: %s", error)
        # Keep only the resources current tools point at; old ones are read from genui when asked for.
        wanted = {resource_uri(t) for t in self._snapshot.tools} if self._snapshot else set()
        for uri in [u for u in self._resources if u not in wanted]:
            del self._resources[uri]

    async def _refresh(self) -> None:
        """Runs on the client's loop. Returns once a check that started after this call has finished."""
        self._requested += 1
        requested = self._requested
        async with self._lock:
            if self._completed >= requested:
                return  # a check that started after this call already ran
            started = self._requested
            await self._check()
            self._completed = started

    def _used(self) -> None:
        """A host is using genui's tools: an old copy is checked in the background, never delaying the caller."""
        if self._interval > 0 and not self._lock.locked() and time.monotonic() - self._checked_at > self._interval:
            asyncio.run_coroutine_threadsafe(self._refresh(), self._loop)

    async def _start(self) -> None:
        try:
            await self._refresh()
        finally:
            self._ready.set()
        # Never loaded (genui down or a bad token at start): no genui tool is mounted to be used, so retry on a timer.
        while self._snapshot is None and self._interval > 0 and not self._closed.is_set():
            await asyncio.sleep(self._interval)
            if not self._closed.is_set():
                await self._refresh()

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.create_task(self._start())
        self._loop.run_forever()


def connect_genui(
    url: str,
    token: str,
    *,
    refresh_seconds: float = 60,
    timeout: float = 10,
    client_factory: ClientFactory | None = None,
    fetch_revision: RevisionSource | None = None,
    logger: logging.Logger | None = None,
) -> GenUIClient:
    """Connects to one environment of genui's end-user MCP, once per process.

    The URL picks the environment. A process that serves two environments connects twice.

    Args:
        url: The workspace's end-user MCP, or your self-hosted genui: e.g. https://mcp.genui.example/w/<workspace>/mcp
            for prod, https://mcp.genui.example/w/<workspace>/<environment>/mcp for another environment.
        token: Workspace server token (scope: server).
        refresh_seconds: When genui's tools are used and the copy is older than this, a check runs in the
            background: one small request, and a re-list only if genui changed. 0 checks only on refresh().
        timeout: Per-request timeout in seconds.
        client_factory: Builds the MCP client, for tests (e.g. an in-process server).
        fetch_revision: Reads genui's revision, for tests with client_factory. Without one, such clients
            re-list on every check.
    """
    return GenUIClient(
        url,
        token,
        refresh_seconds=refresh_seconds,
        timeout=timeout,
        client_factory=client_factory,
        fetch_revision=fetch_revision,
        logger=logger,
    )
