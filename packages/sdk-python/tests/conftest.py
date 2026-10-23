from __future__ import annotations

import uuid
from typing import Any

import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.resources import TextResource
from mcp.types import CallToolResult, TextContent

MIME = "text/html;profile=mcp-app"
THEME = {"light": {"primary": "#16a34a"}}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def html(label: str) -> str:
    return f"<!doctype html><html><body>{label}</body></html>"


class FakeGenUI:
    """genui's end-user MCP, served in-process: built per request like apps/registry, one server per channel.

    Publishing moves beta, promote copies beta to stable, rollback restores stable's previous version.
    """

    def __init__(self) -> None:
        self.rating: dict[str, list[str]] = {"beta": [], "stable": []}
        self.versions: dict[str, str] = {}  # version -> html
        self.down = False
        self.sessions = 0

    def publish(self, version: str) -> None:
        self.versions[version] = html(f"rating v{version}")
        self.rating["beta"].append(version)

    def promote(self) -> None:
        self.rating["stable"].append(self.rating["beta"][-1])

    def rollback(self) -> None:
        self.rating["stable"].pop()

    @staticmethod
    def uri(version: str) -> str:
        return f"ui://genui/c/rating/{version.replace('.', '')}"

    def build(self, channel: str) -> MCPServer:
        server = MCPServer("Acme")

        def result(text: str) -> CallToolResult:
            return CallToolResult(
                content=[TextContent(type="text", text=text)], _meta={"genui/theme": THEME, "genui/viewId": str(uuid.uuid4())}
            )

        @server.tool(name="render_form", title="Show form", description="Show a form.", meta={"ui": {"resourceUri": "ui://genui/form/aaaa"}})
        def render_form(fields: list[dict[str, Any]], title: str | None = None) -> CallToolResult:
            return result(f"Showing form ({len(fields)} fields).")

        server.add_resource(TextResource(uri="ui://genui/form/aaaa", name="genui form", mime_type=MIME, text=html("form")))

        version = self.rating[channel][-1]

        @server.tool(name="render_rating", description="Ask for a rating.", meta={"ui": {"resourceUri": self.uri(version)}})
        def render_rating(question: str) -> CallToolResult:
            return result("Showing Star rating.")

        server.add_resource(TextResource(uri=self.uri(version), name="genui rating", mime_type=MIME, text=self.versions[version]))

        @server.resource("ui://genui/c/rating/{digest}", mime_type=MIME)
        def rating_version(digest: str) -> str:
            return next(body for v, body in self.versions.items() if v.replace(".", "") == digest)

        @server.prompt(name="add_item", title="Add item", description="The user wants to add an item.")
        def add_item(details: str | None = None) -> str:
            return f'Use the "add_item" recipe. Pre-fill from: {details}'

        return server

    def client(self, channel: str, mode: str = "legacy") -> Client:
        if self.down:
            raise ConnectionError("genui is down")
        self.sessions += 1
        return Client(self.build(channel), mode=mode)


@pytest.fixture
def fake_genui() -> FakeGenUI:
    fake = FakeGenUI()
    fake.publish("1.0.0")
    fake.promote()
    fake.publish("1.1.0")
    return fake
