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

from app_mcp import AppMcpClient, connect_app_mcp, mount_app_mcp, refresh_endpoint

from .conftest import FakeAppMcp

pytestmark = pytest.mark.anyio

clients: list[AppMcpClient] = []


@pytest.fixture(autouse=True)
def close_clients() -> Any:
    yield
    while clients:
        clients.pop().close()


class Environment:
    """app-mcp's side of one environment: the fake end-user MCP plus its revision, bumped on publish."""

    def __init__(self, fake: FakeAppMcp) -> None:
        self.fake = fake
        self.revision = 1
        self.revision_reads = 0

    def publish(self, version: str) -> None:
        self.fake.publish(version)
        self.revision += 1

    async def read_revision(self) -> int:
        self.revision_reads += 1
        return self.revision

    def connect(self, refresh_seconds: float = 0) -> AppMcpClient:
        client = connect_app_mcp(
            "https://app-mcp.test/w/acme/mcp",
            "server-token",
            refresh_seconds=refresh_seconds,
            client_factory=self.fake.client,
            fetch_revision=self.read_revision,
        )
        clients.append(client)
        client.ready()
        return client


@pytest.fixture
def env(fake_app_mcp: FakeAppMcp) -> Environment:
    return Environment(fake_app_mcp)


@asynccontextmanager
async def company_server(app_mcp: AppMcpClient) -> AsyncIterator[Client]:
    server = MCPServer("acme")
    mount_app_mcp(server, app_mcp, watch=True)
    async with Client(server) as client:
        yield client


async def rating_uri(client: Client) -> str | None:
    found = next((t for t in (await client.list_tools()).tools if t.name == "render_rating"), None)
    return found.meta["ui"]["resourceUri"] if found else None


async def test_relists_only_when_the_revision_changed(env: Environment) -> None:
    app_mcp = env.connect()
    assert app_mcp.revision() == 1

    sessions = env.fake.sessions
    app_mcp.refresh()
    assert env.fake.sessions == sessions  # the revision, nothing else

    env.publish("1.1.0")
    app_mcp.refresh()
    assert env.fake.sessions == sessions + 1
    assert app_mcp.revision() == 2

    reads = env.revision_reads
    app_mcp.refresh(at_least=2)
    assert env.revision_reads == reads


async def test_checks_an_old_copy_in_the_background_when_used(env: Environment) -> None:
    app_mcp = env.connect(refresh_seconds=0.05)
    async with company_server(app_mcp) as client:
        before = await rating_uri(client)
        env.publish("1.1.0")
        await anyio.sleep(0.08)
        # Answered from the copy at once; the check runs after it.
        await client.call_tool("render_form", {"fields": []})
        with anyio.fail_after(2):
            while await rating_uri(client) == before:
                await anyio.sleep(0.01)
        assert app_mcp.revision() == 2


async def test_refresh_endpoint_refreshes_in_the_background(env: Environment) -> None:
    app_mcp = env.connect()
    app = Starlette(routes=[Route("/app-mcp/refresh", refresh_endpoint(app_mcp), methods=["POST"])])
    http = TestClient(app)

    reads = env.revision_reads
    response = http.post("/app-mcp/refresh", json={"type": "app-mcp.refresh", "environment": "prod", "revision": 1})
    assert response.status_code == 202
    assert response.json() == {"revision": 1}
    assert env.revision_reads == reads  # already has revision 1

    env.publish("1.1.0")
    assert http.post("/app-mcp/refresh", json={"revision": 2}).status_code == 202
    with anyio.fail_after(2):
        while app_mcp.revision() != 2:
            await anyio.sleep(0.01)
    assert http.post("/app-mcp/refresh", content=b"not json").status_code == 202
