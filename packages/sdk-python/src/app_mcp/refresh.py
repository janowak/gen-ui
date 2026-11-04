"""Your server's refresh endpoint: app-mcp calls it after every change to what your environment serves.

A port of `packages/sdk/src/refresh.ts`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .client import AppMcpClient


def refresh_endpoint(app_mcp: AppMcpClient) -> Callable[[Request], Awaitable[Response]]:
    """A Starlette endpoint that re-lists app-mcp's tools in the background when app-mcp calls it.

    app-mcp calls it after a publish or a theme, instructions or workflow save, so your server serves the change now
    instead of at its next check. Register its URL with `app-mcp env set <environment> --refresh-url <url>`.

        server.custom_route("/app-mcp/refresh", methods=["POST"])(refresh_endpoint(app_mcp))

    It answers 202 at once. The body only names a revision, and an up-to-date client ignores it, so
    the endpoint needs no secret.
    """

    async def endpoint(request: Request) -> Response:
        try:
            body = await request.json()
        except ValueError:
            body = {}
        revision = body.get("revision") if isinstance(body, dict) else None
        at_least = revision if isinstance(revision, int) and not isinstance(revision, bool) else None
        app_mcp.refresh(at_least, wait=False)
        return JSONResponse({"revision": app_mcp.revision()}, status_code=202)

    return endpoint
