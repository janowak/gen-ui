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


class FakeAppMcp:
    """One environment of app-mcp's end-user MCP, served in-process: built per request like apps/registry.

    Publishing a rating version makes it the current one.
    """

    def __init__(self) -> None:
        self.rating: str | None = None  # current version
        self.versions: dict[str, str] = {}  # version -> html
        self.resource_meta: dict[str, Any] | None = None
        self.down = False
        self.sessions = 0

    def publish(self, version: str) -> None:
        self.versions[version] = html(f"rating v{version}")
        self.rating = version

    @staticmethod
    def uri(version: str) -> str:
        return f"ui://app-mcp/c/rating/{version.replace('.', '')}"

    def build(self) -> MCPServer:
        server = MCPServer("Acme")

        def result(text: str) -> CallToolResult:
            view_id = str(uuid.uuid4())
            return CallToolResult(
                content=[TextContent(type="text", text=text)],
                structured_content={"appMcp": {"id": view_id}},
                _meta={"app-mcp/theme": THEME, "app-mcp/viewId": view_id},
            )

        @server.tool(name="render_form", title="Show form", description="Show a form.", meta={"ui": {"resourceUri": "ui://app-mcp/form/aaaa"}})
        def render_form(fields: list[dict[str, Any]], title: str | None = None) -> CallToolResult:
            return result(f"Showing form ({len(fields)} fields).")

        server.add_resource(TextResource(uri="ui://app-mcp/form/aaaa", name="app-mcp form", mime_type=MIME, text=html("form")))

        version = self.rating
        assert version is not None

        @server.tool(name="render_rating", description="Ask for a rating.", meta={"ui": {"resourceUri": self.uri(version)}})
        def render_rating(question: str) -> CallToolResult:
            return result("Showing Star rating.")

        server.add_resource(TextResource(uri=self.uri(version), name="app-mcp rating", mime_type=MIME, text=self.versions[version], meta=self.resource_meta))

        @server.resource("ui://app-mcp/c/rating/{digest}", mime_type=MIME)
        def rating_version(digest: str) -> str:
            return next(body for v, body in self.versions.items() if v.replace(".", "") == digest)

        @server.prompt(name="add_item", title="Add item", description="The user wants to add an item.")
        def add_item(details: str | None = None) -> str:
            return f"Show a form with the name and submit to create_item.\n\ndetails: {details}"

        async def resource_metadata(ctx: Any, call_next: Any) -> Any:
            result = await call_next(ctx)
            if ctx.method == "resources/read" and self.resource_meta:
                for content in result.get("contents", []):
                    content["_meta"] = self.resource_meta
            return result

        server.middleware.append(resource_metadata)
        return server

    def client(self, mode: str = "legacy") -> Client:
        if self.down:
            raise ConnectionError("app-mcp is down")
        self.sessions += 1
        return Client(self.build(), mode=mode)


@pytest.fixture
def fake_app_mcp() -> FakeAppMcp:
    fake = FakeAppMcp()
    fake.publish("1.0.0")
    return fake
