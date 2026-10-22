"""Mirrors packages/sdk/src/registry.test.ts against an in-process fake of the registry API."""

from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
import httpx2
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer

from genui import COMPONENT_CONTRACT, THEME_META_KEY, RegistryClient, create_registry_client, mount_genui

from .conftest import FakeRegistry, html, rating

pytestmark = pytest.mark.anyio

clients: list[RegistryClient] = []


@pytest.fixture(autouse=True)
def close_clients() -> Any:
    yield
    while clients:
        clients.pop().close()


def registry_client(fake: FakeRegistry, **extra: Any) -> RegistryClient:
    options: dict[str, Any] = {"refresh_seconds": 0, "transport": fake.transport(), **extra}
    client = create_registry_client("https://registry.test", FakeRegistry.token, **options)
    clients.append(client)
    return client


@asynccontextmanager
async def connect(registry: RegistryClient, channel: str, watch: bool = False, mode: str = "legacy", **client: Any):
    server = MCPServer("test")
    handle = mount_genui(server, registry=registry, channel=channel, watch=watch)
    async with Client(server, mode=mode, **client) as c:
        yield c, handle


async def uri_of(client: Client, tool: str) -> str | None:
    found = next((t for t in (await client.list_tools()).tools if t.name == tool), None)
    return found.meta["ui"]["resourceUri"] if found else None


async def test_mounts_the_channels_version_as_render_name_with_the_registry_theme(fake_registry: FakeRegistry) -> None:
    registry = registry_client(fake_registry)
    async with connect(registry, "stable") as (stable, stable_handle), connect(registry, "beta") as (beta, beta_handle):
        assert stable_handle.components() == ["rating@1.0.0"]
        assert beta_handle.components() == ["rating@1.1.0"]
        stable_uri = await uri_of(stable, "render_rating")
        assert re.fullmatch(r"ui://genui/c/rating/[0-9a-f]{16}", stable_uri)
        assert await uri_of(beta, "render_rating") != stable_uri

        resource = await stable.read_resource(stable_uri)
        assert "v1" in resource.contents[0].text
        assert resource.contents[0].mime_type == "text/html;profile=mcp-app"

        result = await stable.call_tool("render_rating", {"question": "How was it?"})
        assert not result.is_error
        assert result.content[0].text == "Showing Star rating."
        assert result.meta[THEME_META_KEY] == {"light": {"primary": "#16a34a"}}

        invalid = await stable.call_tool("render_rating", {})
        assert invalid.is_error  # props schema is enforced

    assert all(r.headers["authorization"] == "Bearer server-token" for r in fake_registry.requests)


@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_resyncs_a_watching_server_when_stable_is_promoted(fake_registry: FakeRegistry, mode: str) -> None:
    registry = registry_client(fake_registry)
    notifications: list[str] = []

    async def on_message(message: Any) -> None:
        notifications.append(getattr(message, "method", type(message).__name__))

    async with connect(registry, "stable", watch=True, mode=mode, message_handler=on_message) as (client, handle):
        before = await uri_of(client, "render_rating")

        fake_registry.promote("rating")
        registry.refresh()
        assert handle.components() == ["rating@1.1.0"]
        assert await uri_of(client, "render_rating") != before

        fake_registry.rollback("rating", "stable")
        registry.refresh()
        assert handle.components() == ["rating@1.0.0"]
        assert await uri_of(client, "render_rating") == before
        # The replaced version stays readable for hosts re-rendering older messages.
        assert "v1.1" in (await client.read_resource(f"ui://genui/c/rating/{fake_registry.catalog('beta')['components'][0]['hash']}")).contents[0].text

        await anyio.sleep(0.05)
        if mode == "legacy":  # 2026-07-28 clients get list changes over subscriptions/listen instead
            assert notifications.count("notifications/tools/list_changed") == 2
            assert "notifications/resources/list_changed" in notifications
        handle.close()


async def test_watch_mode_advertises_list_changed_to_handshake_clients(fake_registry: FakeRegistry) -> None:
    async with connect(registry_client(fake_registry), "stable", watch=True) as (client, _):
        capabilities = client.session.server_capabilities
        assert capabilities.tools.list_changed and capabilities.resources.list_changed and capabilities.prompts.list_changed


async def test_resyncs_registry_recipes_and_notifies_prompt_changes(fake_registry: FakeRegistry) -> None:
    registry = registry_client(fake_registry)
    notifications: list[str] = []

    async def on_message(message: Any) -> None:
        notifications.append(getattr(message, "method", ""))

    async with connect(registry, "stable", watch=True, message_handler=on_message) as (client, _):
        assert "use_recipe" not in [t.name for t in (await client.list_tools()).tools]
        fake_registry.recipes = [{"name": "rate_us", "when": "The user wants to leave feedback.", "form": {"fields": [{"name": "text", "label": "Feedback", "type": "textarea"}]}}]
        registry.refresh()
        assert "use_recipe" in [t.name for t in (await client.list_tools()).tools]
        assert [p.name for p in (await client.list_prompts()).prompts] == ["rate_us"]
        await anyio.sleep(0.05)
        assert "notifications/prompts/list_changed" in notifications


async def test_keeps_the_last_good_version_when_the_registry_is_unreachable_including_after_a_restart(
    fake_registry: FakeRegistry, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    cache_file = tmp_path / "cache.json"
    first = registry_client(fake_registry, cache_file=cache_file)
    first.ready()
    assert first.snapshot("stable").catalog["components"][0]["version"] == "1.0.0"

    fake_registry.down = True
    with caplog.at_level(logging.WARNING, logger="genui"):
        first.refresh()  # still fine
    assert first.snapshot("stable").catalog["components"][0]["version"] == "1.0.0"
    assert "keeping last good version" in caplog.text

    restarted = registry_client(fake_registry, cache_file=cache_file)
    restarted.ready()
    assert restarted.snapshot("stable").catalog["components"][0]["version"] == "1.0.0"

    async with connect(restarted, "stable") as (_, handle):
        assert handle.components() == ["rating@1.0.0"]


async def test_rejects_bundles_that_fail_hash_verification(fake_registry: FakeRegistry, caplog: pytest.LogCaptureFixture) -> None:
    registry = registry_client(fake_registry)
    registry.ready()
    fake_registry.publish(rating("1.2.0"), html("v1.2"))
    fake_registry.tampered.add(fake_registry.catalog("beta")["components"][0]["hash"])
    with caplog.at_level(logging.WARNING, logger="genui"):
        registry.refresh()
    assert "failed hash verification" in caplog.text
    assert registry.snapshot("beta").catalog["components"][0]["version"] == "1.1.0"


async def test_skips_components_built_for_a_newer_component_contract(fake_registry: FakeRegistry, caplog: pytest.LogCaptureFixture) -> None:
    future = {**rating("1.0.0"), "name": "future", "contract": COMPONENT_CONTRACT + 1}
    fake_registry.publish(future, html("future"))
    with caplog.at_level(logging.WARNING, logger="genui"):
        async with connect(registry_client(fake_registry), "beta") as (_, handle):
            assert handle.components() == ["rating@1.1.0"]
    assert f"needs component contract {COMPONENT_CONTRACT + 1}" in caplog.text


async def test_polls_in_the_background() -> None:
    fake = FakeRegistry()
    registry = registry_client(fake, refresh_seconds=0.05)
    registry.ready()
    assert registry.snapshot("stable").catalog["components"] == []
    fake.publish(rating("1.0.0"), html("v1"))
    fake.promote("rating")
    with anyio.fail_after(2):
        while not registry.snapshot("stable").catalog["components"]:
            await anyio.sleep(0.02)


def test_an_unauthorized_token_leaves_no_snapshot(caplog: pytest.LogCaptureFixture) -> None:
    fake = FakeRegistry()
    with caplog.at_level(logging.WARNING, logger="genui"):
        registry = create_registry_client("https://registry.test", "wrong", refresh_seconds=0, transport=fake.transport())
        registry.ready()
    registry.close()
    assert registry.snapshot("stable") is None
    assert "HTTP 401" in caplog.text


def test_unreachable_registry_without_cache_still_mounts_built_in_tools() -> None:
    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("ECONNREFUSED", request=request)

    registry = create_registry_client("https://registry.test", "t", refresh_seconds=0, transport=httpx2.MockTransport(refuse))
    clients.append(registry)
    handle = mount_genui(MCPServer("offline"), registry=registry)
    assert handle.components() == []
