"""Mirrors packages/sdk/src/mount.test.ts against an in-process fake of genui's end-user MCP."""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer

from genui import GenUIClient, connect_genui, mount_genui

from .conftest import THEME, FakeGenUI, html

pytestmark = pytest.mark.anyio

# "legacy" runs the initialize handshake (2025-11-25); "auto" talks 2026-07-28 to an in-process server.
MODES = ["legacy", "auto"]

clients: list[GenUIClient] = []


@pytest.fixture(autouse=True)
def close_clients() -> Any:
    yield
    while clients:
        clients.pop().close()


def genui_client(fake: FakeGenUI, url: str = "https://genui.test/w/acme/mcp", **extra: Any) -> GenUIClient:
    client = connect_genui(url, "server-token", refresh_seconds=0, client_factory=fake.client, **extra)
    clients.append(client)
    return client


@asynccontextmanager
async def company_server(genui: GenUIClient, watch: bool = False, mode: str = "legacy", **client: Any) -> AsyncIterator[tuple[Client, Any]]:
    """The company's own server: its data tools plus genui's, as a host sees it."""
    server = MCPServer("acme")

    @server.tool(description="Search customers.")
    def search_customers(query: str | None = None) -> list[str]:
        return []

    handle = mount_genui(server, genui, watch=watch)
    async with Client(server, mode=mode, **client) as c:
        yield c, handle


async def uri_of(client: Client, tool: str) -> str | None:
    found = next((t for t in (await client.list_tools()).tools if t.name == tool), None)
    return found.meta["ui"]["resourceUri"] if found else None


async def text_of(client: Client, tool: str) -> str:
    uri = await uri_of(client, tool)
    assert uri is not None
    return (await client.read_resource(uri)).contents[0].text


@pytest.mark.parametrize("mode", MODES)
async def test_puts_genuis_tools_and_prompts_next_to_the_companys_own(fake_genui: FakeGenUI, mode: str) -> None:
    async with company_server(genui_client(fake_genui), mode=mode) as (client, handle):
        tools = (await client.list_tools()).tools
        assert {"search_customers", "render_form", "render_rating"} <= {t.name for t in tools}
        assert sorted(handle.tools()) == ["render_form", "render_rating"]

        # Schemas are genui's, not derived from a Python signature.
        form = next(t for t in tools if t.name == "render_form")
        assert form.input_schema["required"] == ["fields"]
        assert form.title == "Show form"

        assert [p.name for p in (await client.list_prompts()).prompts] == ["add_item"]
        prompt = await client.get_prompt("add_item", {"details": "a blue mug"})
        assert "a blue mug" in prompt.messages[0].content.text


@pytest.mark.parametrize("mode", MODES)
async def test_forwards_calls_and_returns_genuis_result(fake_genui: FakeGenUI, mode: str) -> None:
    async with company_server(genui_client(fake_genui), mode=mode) as (client, _):
        result = await client.call_tool("render_rating", {"question": "How was it?"})
        assert not result.is_error
        assert result.meta["genui/theme"] == THEME
        assert re.fullmatch(r"[0-9a-f-]{36}", result.meta["genui/viewId"])
        assert result.structured_content == {"genui": {"id": result.meta["genui/viewId"]}}


async def test_answers_tools_list_and_resource_reads_from_memory(fake_genui: FakeGenUI) -> None:
    async with company_server(genui_client(fake_genui)) as (client, _):
        before = fake_genui.sessions
        assert await text_of(client, "render_rating") == html("rating v1.0.0")
        assert await text_of(client, "render_rating") == html("rating v1.0.0")
        assert fake_genui.sessions == before

        await client.call_tool("render_form", {"fields": []})
        assert fake_genui.sessions == before + 1


async def test_serves_one_environment_per_client(fake_genui: FakeGenUI) -> None:
    dev = FakeGenUI()
    dev.publish("1.1.0")
    prod_genui = genui_client(fake_genui)
    dev_genui = genui_client(dev, "https://genui.test/w/acme/dev/mcp")
    async with company_server(prod_genui) as (prod, _), company_server(dev_genui) as (dev_server, _):
        assert await text_of(prod, "render_rating") == html("rating v1.0.0")
        assert await text_of(dev_server, "render_rating") == html("rating v1.1.0")


@pytest.mark.parametrize("mode", MODES)
async def test_resyncs_a_watching_server_and_notifies_the_host(fake_genui: FakeGenUI, mode: str) -> None:
    genui = genui_client(fake_genui)
    notifications: list[str] = []

    async def on_message(message: Any) -> None:
        notifications.append(getattr(message, "method", type(message).__name__))

    async with company_server(genui, watch=True, mode=mode, message_handler=on_message) as (client, handle):
        before = await uri_of(client, "render_rating")
        fake_genui.publish("1.1.0")
        genui.refresh()
        after = await uri_of(client, "render_rating")
        assert after != before
        assert await text_of(client, "render_rating") == html("rating v1.1.0")
        # An old message still renders: the earlier version is read from genui.
        assert (await client.read_resource(before)).contents[0].text == html("rating v1.0.0")

        await anyio.sleep(0.05)
        if mode == "legacy":  # 2026-07-28 clients get list changes over subscriptions/listen instead
            assert "notifications/tools/list_changed" in notifications
        handle.close()


async def test_returns_a_clear_error_when_genui_is_unreachable(fake_genui: FakeGenUI, caplog: pytest.LogCaptureFixture) -> None:
    async with company_server(genui_client(fake_genui)) as (client, _):
        fake_genui.down = True
        with caplog.at_level(logging.WARNING, logger="genui"):
            result = await client.call_tool("render_form", {"fields": []})
        assert result.is_error
        assert result.content[0].text == "genui is unavailable right now, try again shortly."
        assert "genui unreachable" in caplog.text


async def test_mounts_nothing_when_genui_was_never_reached(fake_genui: FakeGenUI, caplog: pytest.LogCaptureFixture) -> None:
    fake_genui.down = True
    with caplog.at_level(logging.WARNING, logger="genui"):
        async with company_server(genui_client(fake_genui)) as (client, handle):
            assert [t.name for t in (await client.list_tools()).tools] == ["search_customers"]
            assert handle.tools() == []
    assert "could not list genui's tools" in caplog.text
