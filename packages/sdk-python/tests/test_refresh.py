"""Mirrors packages/sdk/src/refresh.test.ts: re-list only on a new revision, check on use, refresh endpoint."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from genui import GenUIClient, connect_genui, mount_genui, refresh_endpoint

from .conftest import FakeGenUI

pytestmark = pytest.mark.anyio

clients: list[GenUIClient] = []


@pytest.fixture(autouse=True)
def close_clients() -> Any:
    yield
    while clients:
        clients.pop().close()


class Environment:
    """genui's side of one environment: the fake end-user MCP plus its revision, bumped on publish."""

    def __init__(self, fake: FakeGenUI) -> None:
        self.fake = fake
        self.revision = 1
        self.revision_reads = 0

    def publish(self, version: str) -> None:
        self.fake.publish(version)
        self.revision += 1

    async def read_revision(self) -> int:
        self.revision_reads += 1
        return self.revision

    def connect(self, refresh_seconds: float = 0) -> GenUIClient:
        client = connect_genui(
            "https://genui.test/w/acme/mcp",
            "server-token",
            refresh_seconds=refresh_seconds,
            client_factory=self.fake.client,
            fetch_revision=self.read_revision,
        )
        clients.append(client)
        client.ready()
        return client


@pytest.fixture
def env(fake_genui: FakeGenUI) -> Environment:
    return Environment(fake_genui)


@asynccontextmanager
async def company_server(genui: GenUIClient) -> AsyncIterator[Client]:
    server = MCPServer("acme")
    mount_genui(server, genui, watch=True)
    async with Client(server) as client:
        yield client


async def rating_uri(client: Client) -> str | None:
    found = next((t for t in (await client.list_tools()).tools if t.name == "render_rating"), None)
    return found.meta["ui"]["resourceUri"] if found else None


async def test_relists_only_when_the_revision_changed(env: Environment) -> None:
    genui = env.connect()
    assert genui.revision() == 1

    sessions = env.fake.sessions
    genui.refresh()
    assert env.fake.sessions == sessions  # the revision, nothing else

    env.publish("1.1.0")
    genui.refresh()
    assert env.fake.sessions == sessions + 1
    assert genui.revision() == 2

    reads = env.revision_reads
    genui.refresh(at_least=2)
    assert env.revision_reads == reads


async def test_checks_an_old_copy_in_the_background_when_used(env: Environment) -> None:
    genui = env.connect(refresh_seconds=0.05)
    async with company_server(genui) as client:
        before = await rating_uri(client)
        env.publish("1.1.0")
        await anyio.sleep(0.08)
        # Answered from the copy at once; the check runs after it.
        await client.call_tool("render_form", {"fields": []})
        with anyio.fail_after(2):
            while await rating_uri(client) == before:
                await anyio.sleep(0.01)
        assert genui.revision() == 2


async def test_refresh_endpoint_refreshes_in_the_background(env: Environment) -> None:
    genui = env.connect()
    app = Starlette(routes=[Route("/genui/refresh", refresh_endpoint(genui), methods=["POST"])])
    http = TestClient(app)

    reads = env.revision_reads
    response = http.post("/genui/refresh", json={"type": "genui.refresh", "environment": "prod", "revision": 1})
    assert response.status_code == 202
    assert response.json() == {"revision": 1}
    assert env.revision_reads == reads  # already has revision 1

    env.publish("1.1.0")
    assert http.post("/genui/refresh", json={"revision": 2}).status_code == 202
    with anyio.fail_after(2):
        while genui.revision() != 2:
            await anyio.sleep(0.01)
    assert http.post("/genui/refresh", content=b"not json").status_code == 202
