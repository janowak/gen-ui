"""genui for Python MCP servers: forms, charts and registry components rendered as MCP Apps.

    from mcp.server.mcpserver import MCPServer
    from genui import mount_genui

    server = MCPServer("acme")
    mount_genui(server)
"""

from .meta import (
    COMPONENT_CONTRACT,
    FORM_META_KEY,
    PREVIEW_META_KEY,
    RESOURCE_MIME_TYPE,
    THEME_META_KEY,
    VIEW_ID_META_KEY,
)
from .mount import GenUIHandle, mount_genui
from .recipe import recipe_form
from .registry import RegistryClient, Snapshot, create_registry_client
from .views import ViewBundle, bundle, load_built_in_views, tool_schema

__all__ = [
    "COMPONENT_CONTRACT",
    "FORM_META_KEY",
    "PREVIEW_META_KEY",
    "RESOURCE_MIME_TYPE",
    "THEME_META_KEY",
    "VIEW_ID_META_KEY",
    "GenUIHandle",
    "RegistryClient",
    "Snapshot",
    "ViewBundle",
    "bundle",
    "create_registry_client",
    "load_built_in_views",
    "mount_genui",
    "recipe_form",
    "tool_schema",
]
