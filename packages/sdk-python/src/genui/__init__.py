"""genui for Python MCP servers: forms, charts and registry components rendered as MCP Apps.

    from mcp.server.mcpserver import MCPServer
    from genui import connect_genui, mount_genui

    genui = connect_genui(url="https://mcp.genui.example/w/<workspace>/mcp", token="...")
    server = MCPServer("acme")
    mount_genui(server, genui)
"""

from .client import GenUIClient, Snapshot, connect_genui
from .mount import GenUIHandle, mount_genui
from .refresh import refresh_endpoint

__all__ = ["GenUIClient", "GenUIHandle", "Snapshot", "connect_genui", "mount_genui", "refresh_endpoint"]
