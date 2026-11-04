"""app-mcp for Python MCP servers: forms, charts and registry components rendered as MCP Apps.

    from mcp.server.mcpserver import MCPServer
    from app_mcp import connect_app_mcp, mount_app_mcp

    app_mcp = connect_app_mcp(url="https://mcp.app-mcp.example/w/<workspace>/mcp", token="...")
    server = MCPServer("acme")
    mount_app_mcp(server, app_mcp)
"""

from .client import AppMcpClient, Snapshot, connect_app_mcp
from .mount import AppMcpHandle, mount_app_mcp
from .refresh import refresh_endpoint

__all__ = ["AppMcpClient", "AppMcpHandle", "Snapshot", "connect_app_mcp", "mount_app_mcp", "refresh_endpoint"]
