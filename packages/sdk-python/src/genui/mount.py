"""`mount_genui`: registers render_form, render_chart, use_recipe and registry components on an MCPServer.

A port of `packages/sdk/src/mount.ts` for servers that run their own data tools.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import threading
import uuid
import weakref
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Annotated, Any

from jsonschema import Draft202012Validator
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.prompts.base import Prompt
from mcp.server.mcpserver.resources import TextResource
from mcp.server.subscriptions import PromptsListChanged, ResourcesListChanged, SubscriptionBus, ToolsListChanged
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from .meta import COMPONENT_CONTRACT, FORM_META_KEY, RESOURCE_MIME_TYPE, THEME_META_KEY, VIEW_ID_META_KEY
from .recipe import recipe_form
from .registry import RegistryClient
from .views import ViewBundle, load_built_in_views, tool_schema

Theme = Mapping[str, Any]
ThemeOption = Theme | Callable[[], Theme | None | Awaitable[Theme | None]]
Handler = Callable[[dict[str, Any]], Awaitable[CallToolResult]]

logger = logging.getLogger("genui")

FORM_DESCRIPTION = (
    "Show an interactive form to the user inside the chat. Use it to collect structured input instead of asking question by question. "
    "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect, resource_select, resource_multiselect. "
    "resource_select / resource_multiselect load options by calling a tool (source.toolName) with source.params (fill the tool's required parameters) "
    "and send the user's search text in source.searchParam; map results with itemsPath, idPath, labelPath. "
    "With `submit`, the form calls submit.toolName with the field values (keyed by field name) merged into submit.params; field names must match that tool's parameters. "
    "Without `submit`, the values are sent back to the conversation. Do not call the submit tool yourself."
)

CHART_DESCRIPTION = (
    "Show a chart (line, bar, area, pie, donut) inside the chat. Three ways to pass data: "
    "data.rows (rows you already have; map them with `x` and `series`), "
    "data.categories + data.series (chart-native values for small charts), or "
    "data.source (the chart calls a tool itself; use for ~200+ rows or live data, optionally with refreshSeconds). "
    "Pie and donut plot the first series."
)

RECIPE_DESCRIPTION = (
    "Show one of this workspace's ready-made forms. Prefer it over render_form whenever a recipe matches what the user wants. "
    "Pick the recipe and pre-fill the fields you already know from the conversation; the fields, validation and submit action are fixed. "
    "Do not call the submit tool yourself.\nRecipes:\n"
)


class GenUIHandle:
    """What `mount_genui` returns."""

    def __init__(self, views: dict[str, ViewBundle], components: Callable[[], list[str]], close: Callable[[], None]):
        self.views = views
        self._components = components
        self._close = close

    def components(self) -> list[str]:
        """Custom components currently registered, as name@version."""
        return self._components()

    def close(self) -> None:
        """Stops watching the registry."""
        self._close()


def _text(text: str, meta: dict[str, Any]) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], _meta=meta)


def _arguments(ctx: Context) -> dict[str, Any]:
    params = ctx.request_context.params or {}
    arguments = params.get("arguments")
    return dict(arguments) if isinstance(arguments, Mapping) else {}


def _validation_error(validator: Draft202012Validator, arguments: dict[str, Any]) -> str | None:
    errors = sorted(validator.iter_errors(arguments), key=lambda e: list(e.absolute_path))
    if not errors:
        return None
    def where(error: Any) -> str:
        return ".".join(str(part) for part in error.absolute_path) or "(root)"
    return "; ".join(f"{where(error)}: {error.message}" for error in errors[:5])


def _add_tool(
    server: MCPServer,
    name: str,
    *,
    title: str | None,
    description: str,
    input_schema: dict[str, Any],
    resource_uri: str,
    handler: Handler,
) -> None:
    """Registers a tool whose input schema is our JSON Schema rather than one derived from a signature."""
    # MCPServer derives input schemas from function signatures and has no public way to pass a JSON
    # Schema to add_tool; the registered Tool's `parameters` is the schema tools/list advertises.
    tools = server._tool_manager
    if tools.get_tool(name) is not None:
        raise ValueError(f"genui: a tool named {name} is already registered on this server")
    validator = Draft202012Validator(input_schema)

    async def call(ctx: Context) -> CallToolResult:
        arguments = _arguments(ctx)
        error = _validation_error(validator, arguments)
        if error:
            raise ToolError(f"Invalid arguments: {error}")
        return await handler(arguments)

    server.add_tool(
        call,
        name=name,
        title=title,
        description=description,
        meta={"ui": {"resourceUri": resource_uri}},
        structured_output=False,
    )
    tool = tools.get_tool(name)
    assert tool is not None
    tool.parameters = input_schema


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
    *,
    registry: RegistryClient | None = None,
    channel: str = "stable",
    theme: ThemeOption | None = None,
    recipes: Sequence[Mapping[str, Any]] | None = None,
    watch: bool = False,
    bus: SubscriptionBus | None = None,
    views: dict[str, ViewBundle] | None = None,
) -> GenUIHandle:
    """Registers render_form, render_chart, use_recipe and registry components (tools + `ui://` resources).

    Args:
        server: The MCPServer that also serves your data and submit tools.
        registry: Registry to pull custom components, recipes and the theme from.
        channel: Registry channel this server serves, e.g. "beta" for beta testers.
        theme: Workspace theme, or a function returning the current one (may be async). Overrides the registry theme.
        recipes: Recipes offered through use_recipe and as prompts (slash commands). Defaults to the registry's.
        watch: Re-sync components and recipes when the registry changes and notify clients (list_changed).
        bus: The SubscriptionBus passed to MCPServer(subscriptions=...), used for watch notifications to
            2026-07-28 clients. Defaults to the server's own bus.
        views: Override the built-in view bundles.
    """
    views = views or load_built_in_views()
    if registry is not None:
        registry.ready()

    async def current_theme() -> Theme | None:
        if theme is not None:
            if not callable(theme):
                return theme
            value = theme()
            return await value if inspect.isawaitable(value) else value
        snapshot = registry.snapshot(channel) if registry else None
        return snapshot.catalog.get("theme") if snapshot else None

    async def meta() -> dict[str, Any]:
        current = await current_theme()
        return {VIEW_ID_META_KEY: str(uuid.uuid4()), **({THEME_META_KEY: current} if current is not None else {})}

    resources: set[str] = set()

    def add_resource(name: str, uri: str, html: str) -> None:
        # MCPServer has no remove_resource: replaced component versions stay readable, which also lets
        # hosts re-render older messages. Tools always point at the current version.
        if uri in resources:
            return
        resources.add(uri)
        server.add_resource(TextResource(uri=uri, name=f"genui {name}", mime_type=RESOURCE_MIME_TYPE, text=html))

    for view in views.values():
        add_resource(view.name, view.uri, view.html)

    async def render_form(spec: dict[str, Any]) -> CallToolResult:
        count = len(spec["fields"])
        fields = f"{count} field{'' if count == 1 else 's'}"
        title = f' "{spec["title"]}"' if spec.get("title") else ""
        submit = spec.get("submit")
        then = (
            f"When the user submits, the form calls {submit['toolName']} and you receive the submitted values and result in context."
            if submit
            else "When the user submits, the values arrive as a message."
        )
        return _text(f"Showing form{title} ({fields}). {then}", await meta())

    async def render_chart(spec: dict[str, Any]) -> CallToolResult:
        data = spec["data"]
        what = f"data from {data['source']['toolName']}" if "source" in data else "the provided data"
        title = f' "{spec["title"]}"' if spec.get("title") else ""
        return _text(f"Showing {spec['type']} chart{title} with {what}.", await meta())

    _add_tool(
        server,
        "render_form",
        title="Show form",
        description=FORM_DESCRIPTION,
        input_schema=tool_schema("form"),
        resource_uri=views["form"].uri,
        handler=render_form,
    )
    _add_tool(
        server,
        "render_chart",
        title="Show chart",
        description=CHART_DESCRIPTION,
        input_schema=tool_schema("chart"),
        resource_uri=views["chart"].uri,
        handler=render_chart,
    )

    # Registry components: render_<name>, each backed by its own content-hashed ui:// resource.
    mounted: dict[str, tuple[str, str]] = {}  # name -> (hash, version)
    too_new: set[str] = set()
    lock = threading.RLock()

    def mount_component(component: Mapping[str, Any], html: str) -> None:
        manifest = component["manifest"]
        name = manifest["name"]
        label = manifest.get("title") or name
        uri = f"ui://genui/c/{name}/{component['hash']}"
        add_resource(name, uri, html)

        async def render(_: dict[str, Any]) -> CallToolResult:
            return _text(f"Showing {label}.", await meta())

        _add_tool(
            server,
            f"render_{name}",
            title=label,
            description=manifest["description"],
            input_schema={"type": "object", **manifest["props"]},
            resource_uri=uri,
            handler=render,
        )
        mounted[name] = (component["hash"], manifest["version"])

    def sync() -> bool:
        """Brings registered components in line with the channel's snapshot. Returns True if anything changed."""
        snapshot = registry.snapshot(channel) if registry else None
        if snapshot is None:
            return False
        wanted = {c["manifest"]["name"]: c for c in snapshot.catalog["components"]}
        changed = False
        for name, (digest, _) in list(mounted.items()):
            if name not in wanted or wanted[name]["hash"] != digest:
                server.remove_tool(f"render_{name}")
                del mounted[name]
                changed = True
        for name, component in wanted.items():
            if name in mounted:
                continue
            # Built with a newer @genui/kit than this SDK serves: it would render without data it expects.
            contract = component["manifest"].get("contract") or 0
            if contract > COMPONENT_CONTRACT:
                if component["hash"] not in too_new:
                    too_new.add(component["hash"])
                    logger.warning(
                        "[genui] skipping %s@%s: needs component contract %s, this SDK serves %s. Update genui-sdk.",
                        name,
                        component["version"],
                        contract,
                        COMPONENT_CONTRACT,
                    )
                continue
            html = snapshot.bundles.get(component["hash"])
            if html is not None:
                mount_component(component, html)
                changed = True
        return changed

    # Recipes: one use_recipe tool (the server builds the form; the model picks and pre-fills)
    # plus one prompt per recipe, which hosts show as a slash command.
    recipe_state: dict[str, Any] = {"key": None, "tool": False, "prompts": [], "registered": False}

    def mount_recipes() -> bool:
        snapshot = registry.snapshot(channel) if registry else None
        if recipes is not None:
            current = list(recipes)
        else:
            current = (snapshot.catalog.get("recipes") if snapshot else None) or []
        key = json.dumps(current, sort_keys=True)
        if key == recipe_state["key"]:
            return False
        if recipe_state["tool"]:
            server.remove_tool("use_recipe")
        for name in recipe_state["prompts"]:
            server.remove_prompt(name)
        recipe_state.update(key=key, tool=False, prompts=[])
        if not current:
            return True

        by_name = {r["name"]: r for r in current}
        listing = "\n".join(f"- {r['name']}: {r['when']}{' ' + r['notes'] if r.get('notes') else ''}" for r in current)
        schema = tool_schema("recipe-input")
        schema["properties"]["recipe"]["enum"] = list(by_name)

        async def use_recipe(arguments: dict[str, Any]) -> CallToolResult:
            recipe = by_name[arguments["recipe"]]
            form = recipe_form(recipe, arguments.get("prefill"))
            text = f'Showing the "{recipe.get("title") or recipe["name"]}" form. The user fills it in; you receive the result in context.'
            return _text(text, {**(await meta()), FORM_META_KEY: form})

        _add_tool(
            server,
            "use_recipe",
            title="Use recipe",
            description=RECIPE_DESCRIPTION + listing,
            input_schema=schema,
            resource_uri=views["form"].uri,
            handler=use_recipe,
        )
        recipe_state["tool"] = True
        for recipe in current:
            server.add_prompt(_recipe_prompt(recipe))
            recipe_state["prompts"].append(recipe["name"])
        recipe_state["registered"] = True
        return True

    with lock:
        sync()
        mount_recipes()

    cleanup: list[Callable[[], None]] = []
    if registry is not None and watch:
        notifier = _Notifier(server, bus)
        server.middleware.append(notifier.middleware)
        cleanup.append(lambda: server.middleware.remove(notifier.middleware))

        def on_change(changed: str) -> None:
            if changed != channel:
                return
            with lock:
                components_changed = sync()
                recipes_changed = mount_recipes()
            if components_changed or recipes_changed:
                notifier.notify(tools=True, prompts=recipes_changed and recipe_state["registered"])

        cleanup.append(registry.on_change(on_change))

    def close() -> None:
        while cleanup:
            cleanup.pop()()

    return GenUIHandle(
        views=views,
        components=lambda: [f"{name}@{version}" for name, (_, version) in mounted.items()],
        close=close,
    )


def _recipe_prompt(recipe: Mapping[str, Any]) -> Prompt:
    label = recipe.get("title") or recipe["name"]

    def prompt(details: Annotated[str | None, Field(description="Anything to pre-fill, in plain words.")] = None) -> str:
        return f'Use the "{label}" recipe: call use_recipe with recipe "{recipe["name"]}". ' + (
            f"Pre-fill from: {details}" if details else "Pre-fill what you already know from this conversation."
        )

    return Prompt.from_function(prompt, name=recipe["name"], title=label, description=recipe["when"])


__all__ = ["GenUIHandle", "mount_genui"]
