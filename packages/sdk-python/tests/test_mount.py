"""Mirrors packages/sdk/src/mount.test.ts (preview mode and dataTools are Node-only: the registry's hosted MCP)."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer

from genui import FORM_META_KEY, PREVIEW_META_KEY, THEME_META_KEY, VIEW_ID_META_KEY, mount_genui, recipe_form, tool_schema

pytestmark = pytest.mark.anyio

# "legacy" runs the initialize handshake (2025-11-25); "auto" talks 2026-07-28 to an in-process server.
MODES = ["legacy", "auto"]

FORM = {
    "title": "New order",
    "fields": [
        {
            "name": "customer",
            "label": "Customer",
            "type": "resource_select",
            "source": {"toolName": "search_customers", "searchParam": "query", "labelPath": "name"},
        },
        {"name": "notes", "label": "Notes", "type": "textarea"},
    ],
    "submit": {"toolName": "create_order"},
}


def tool_named(tools: Any, name: str) -> Any:
    return next((t for t in tools.tools if t.name == name), None)


@pytest.fixture(params=MODES)
async def client(request: pytest.FixtureRequest) -> AsyncIterator[Client]:
    server = MCPServer("test")
    mount_genui(server, theme={"light": {"primary": "#4f46e5"}})
    async with Client(server, mode=request.param) as c:
        yield c


class TestMountGenUI:
    async def test_registers_render_tools_linked_to_content_hashed_ui_resources(self, client: Client) -> None:
        tools = await client.list_tools()
        form_tool = tool_named(tools, "render_form")
        uri = form_tool.meta["ui"]["resourceUri"]
        assert re.fullmatch(r"ui://genui/form/[0-9a-f]{16}", uri)
        assert tool_named(tools, "render_chart") is not None

        resource = await client.read_resource(uri)
        content = resource.contents[0]
        assert content.mime_type == "text/html;profile=mcp-app"
        assert "<html" in content.text

    async def test_advertises_the_input_schemas_exported_from_format(self, client: Client) -> None:
        tools = await client.list_tools()
        assert tool_named(tools, "render_form").input_schema == tool_schema("form")
        assert tool_named(tools, "render_chart").input_schema == tool_schema("chart")
        assert tool_named(tools, "render_form").title == "Show form"
        assert tool_named(tools, "render_form").description.startswith("Show an interactive form to the user inside the chat.")

    async def test_returns_theme_and_a_view_id_in_meta(self, client: Client) -> None:
        result = await client.call_tool("render_form", FORM)
        assert not result.is_error
        assert PREVIEW_META_KEY not in result.meta
        assert result.meta[THEME_META_KEY] == {"light": {"primary": "#4f46e5"}}
        assert result.content[0].text == (
            'Showing form "New order" (2 fields). When the user submits, the form calls create_order '
            "and you receive the submitted values and result in context."
        )

        again = await client.call_tool("render_form", FORM)
        assert re.fullmatch(r"[0-9a-f-]{36}", result.meta[VIEW_ID_META_KEY])
        assert again.meta[VIEW_ID_META_KEY] != result.meta[VIEW_ID_META_KEY]

    async def test_renders_inline_charts(self, client: Client) -> None:
        result = await client.call_tool(
            "render_chart",
            {"type": "pie", "data": {"categories": ["A", "B"], "series": [{"name": "n", "values": [1, 2]}]}},
        )
        assert not result.is_error
        assert result.content[0].text == "Showing pie chart with the provided data."

        sourced = await client.call_tool("render_chart", {"type": "line", "title": "Revenue", "data": {"source": {"toolName": "get_revenue"}}})
        assert sourced.content[0].text == 'Showing line chart "Revenue" with data from get_revenue.'

    async def test_rejects_specs_that_do_not_match_the_schema(self, client: Client) -> None:
        empty = await client.call_tool("render_form", {"fields": []})
        assert empty.is_error
        assert "fields" in empty.content[0].text

        unknown_type = await client.call_tool("render_chart", {"type": "radar", "data": {"rows": []}})
        assert unknown_type.is_error


async def test_theme_can_be_a_sync_or_async_function() -> None:
    themes = iter([{"radius": "0.5rem"}, None])

    async def current() -> Any:
        return next(themes)

    server = MCPServer("themed")
    mount_genui(server, theme=current)
    async with Client(server) as c:
        first = await c.call_tool("render_form", FORM)
        second = await c.call_tool("render_form", FORM)
    assert first.meta[THEME_META_KEY] == {"radius": "0.5rem"}
    assert THEME_META_KEY not in second.meta

    server = MCPServer("sync-themed")
    mount_genui(server, theme=lambda: {"radius": "0"})
    async with Client(server) as c:
        assert (await c.call_tool("render_chart", {"type": "bar", "data": {"rows": []}})).meta[THEME_META_KEY] == {"radius": "0"}


def test_refuses_to_replace_an_existing_render_tool() -> None:
    server = MCPServer("taken")

    @server.tool()
    def render_form() -> str:
        return "mine"

    with pytest.raises(ValueError, match="render_form is already registered"):
        mount_genui(server)


ADD_ORDER = {
    "name": "add_order",
    "title": "New order",
    "when": "The user wants to create an order.",
    "notes": "Pre-fill the customer when mentioned.",
    "form": {
        "title": "New order",
        "fields": [
            {"name": "customer", "label": "Customer", "type": "resource_select", "source": {"toolName": "search_customers", "labelPath": "name"}},
            {"name": "quantity", "label": "Quantity", "type": "number"},
        ],
        "submit": {"toolName": "create_order"},
    },
}
WIPE = {"name": "wipe", "when": "Never.", "form": {"fields": [{"name": "x", "label": "X", "type": "text"}], "submit": {"toolName": "drop_tables"}}}


@pytest.fixture(params=MODES)
async def recipe_client(request: pytest.FixtureRequest) -> AsyncIterator[Client]:
    server = MCPServer("recipes")
    mount_genui(server, recipes=[ADD_ORDER, WIPE])
    async with Client(server, mode=request.param) as c:
        yield c


class TestRecipes:
    async def test_builds_the_form_on_the_server_from_the_recipe_and_the_models_prefill(self, recipe_client: Client) -> None:
        tool = tool_named(await recipe_client.list_tools(), "use_recipe")
        assert "- add_order: The user wants to create an order. Pre-fill the customer when mentioned." in tool.description
        assert tool.input_schema["properties"]["recipe"]["enum"] == ["add_order", "wipe"]

        result = await recipe_client.call_tool(
            "use_recipe", {"recipe": "add_order", "prefill": {"customer": {"id": "c-2", "label": "Globex"}, "quantity": "3"}}
        )
        assert not result.is_error
        form = result.meta[FORM_META_KEY]
        assert [f.get("defaultValue") for f in form["fields"]] == [{"id": "c-2", "label": "Globex"}, 3]
        assert result.meta[VIEW_ID_META_KEY]
        assert result.content[0].text == 'Showing the "New order" form. The user fills it in; you receive the result in context.'

    async def test_rejects_unknown_recipes(self, recipe_client: Client) -> None:
        result = await recipe_client.call_tool("use_recipe", {"recipe": "drop_everything"})
        assert result.is_error

    async def test_exposes_each_recipe_as_a_prompt(self, recipe_client: Client) -> None:
        prompts = await recipe_client.list_prompts()
        assert [p.name for p in prompts.prompts] == ["add_order", "wipe"]
        assert prompts.prompts[0].title == "New order"
        assert prompts.prompts[0].description == "The user wants to create an order."
        assert prompts.prompts[0].arguments[0].description == "Anything to pre-fill, in plain words."

        prompt = await recipe_client.get_prompt("add_order", {"details": "3 mugs for Globex"})
        text = prompt.messages[0].content.text
        assert 'call use_recipe with recipe "add_order"' in text
        assert "3 mugs for Globex" in text


def test_recipe_form_prefills_with_light_coercion_and_ignores_values_that_dont_fit() -> None:
    """Mirrors the recipes test in packages/format/src/format.test.ts."""
    recipe = {
        "name": "add_item",
        "when": "The user wants to add an item.",
        "form": {
            "fields": [
                {"name": "name", "label": "Name", "type": "text", "required": True},
                {"name": "price", "label": "Price", "type": "number"},
                {"name": "category", "label": "Category", "type": "resource_select", "source": {"toolName": "list_categories", "labelPath": "name"}},
                {"name": "tags", "label": "Tags", "type": "multiselect", "options": [{"id": "new", "label": "New"}]},
            ],
            "submit": {"toolName": "create_item"},
        },
    }
    form = recipe_form(recipe, {"name": "Mug", "price": "12", "category": "c-1", "tags": "new", "unknown": 1})
    by_name = {f["name"]: f.get("defaultValue") for f in form["fields"]}
    assert by_name == {"name": "Mug", "price": 12, "category": {"id": "c-1", "label": "c-1"}, "tags": ["new"]}
    assert recipe_form(recipe, {"price": "not a number"})["fields"][1].get("defaultValue") is None
    assert form["submit"]["toolName"] == "create_item"
    # Scalars become strings for text fields, as JavaScript's String() writes them.
    assert recipe_form(recipe, {"name": True})["fields"][0]["defaultValue"] == "true"
    assert recipe_form(recipe, {"name": 3.0})["fields"][0]["defaultValue"] == "3"
