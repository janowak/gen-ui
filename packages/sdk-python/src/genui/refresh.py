"""Your server's refresh endpoint: genui calls it after every change to what your environment serves.

A port of `packages/sdk/src/refresh.ts`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .client import GenUIClient


def refresh_endpoint(genui: GenUIClient) -> Callable[[Request], Awaitable[Response]]:
    """A Starlette endpoint that re-lists genui's tools in the background when genui calls it.

    genui calls it after a publish or a theme, instructions or workflow save, so your server serves the change now
    instead of at its next check. Register its URL with `genui env set <environment> --refresh-url <url>`.

        server.custom_route("/genui/refresh", methods=["POST"])(refresh_endpoint(genui))

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
        genui.refresh(at_least, wait=False)
        return JSONResponse({"revision": genui.revision()}, status_code=202)

    return endpoint
