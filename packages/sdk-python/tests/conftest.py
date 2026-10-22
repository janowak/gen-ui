from __future__ import annotations

import json
import re
from typing import Any

import httpx2
import pytest

from genui.views import content_hash


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def html(label: str) -> str:
    return f"<!doctype html><html><body>{label}</body></html>"


def rating(version: str, **extra: Any) -> dict[str, Any]:
    return {
        "name": "rating",
        "version": version,
        "title": "Star rating",
        "description": "Ask the user to rate something from 1 to 5 stars.",
        "props": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
        "tools": ["save_rating"],
        **extra,
    }


class FakeRegistry:
    """The registry's server-token API (GET /v1/catalog, GET /v1/bundles/:hash), served in-process.

    Mirrors apps/registry: publishing moves beta, promote copies beta to stable, rollback restores
    the channel's previous version.
    """

    token = "server-token"

    def __init__(self) -> None:
        self.versions: dict[tuple[str, str], tuple[dict[str, Any], str]] = {}
        self.channels: dict[str, dict[str, list[str]]] = {"beta": {}, "stable": {}}
        self.theme: dict[str, Any] | None = None
        self.recipes: list[dict[str, Any]] = []
        self.down = False
        self.tampered: set[str] = set()
        self.requests: list[httpx2.Request] = []

    def publish(self, manifest: dict[str, Any], body: str) -> None:
        self.versions[(manifest["name"], manifest["version"])] = (manifest, body)
        self.channels["beta"].setdefault(manifest["name"], []).append(manifest["version"])

    def promote(self, name: str) -> None:
        self.channels["stable"].setdefault(name, []).append(self.channels["beta"][name][-1])

    def rollback(self, name: str, channel: str = "stable") -> None:
        self.channels[channel][name].pop()

    def catalog(self, channel: str) -> dict[str, Any]:
        components = []
        for name, history in sorted(self.channels[channel].items()):
            manifest, body = self.versions[(name, history[-1])]
            components.append({"name": name, "version": manifest["version"], "hash": content_hash(body), "manifest": manifest})
        return {"channel": channel, "theme": self.theme, "components": components, "recipes": self.recipes}

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.down:
            raise httpx2.ConnectError("ECONNREFUSED", request=request)
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return httpx2.Response(401, json={"error": "unauthorized"})
        if request.url.path == "/v1/catalog":
            channel = request.url.params.get("channel", "stable")
            return httpx2.Response(200, json=self.catalog(channel if channel in self.channels else "stable"))
        match = re.fullmatch(r"/v1/bundles/([0-9a-f]+)", request.url.path)
        if match:
            for _, body in self.versions.values():
                if content_hash(body) == match[1]:
                    return httpx2.Response(200, text=body + ("<!-- tampered -->" if match[1] in self.tampered else ""))
        return httpx2.Response(404, json={"error": "not found"})

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self.handle)


@pytest.fixture
def fake_registry() -> FakeRegistry:
    registry = FakeRegistry()
    registry.publish(rating("1.0.0"), html("v1"))
    registry.promote("rating")
    registry.publish(rating("1.1.0"), html("v1.1"))
    registry.theme = {"light": {"primary": "#16a34a"}}
    return registry


def dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)
