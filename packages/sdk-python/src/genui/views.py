"""Built-in view bundles (`@genui/ui`) and the JSON schemas of the built-in tools (`@genui/format`)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Literal

ViewName = Literal["form", "chart"]


@dataclass(frozen=True)
class ViewBundle:
    name: str
    html: str
    hash: str
    """Content hash; part of the `ui://` URI so hosts never serve a stale cached bundle."""
    uri: str


def content_hash(html: str) -> str:
    """sha256 hex of the UTF-8 bundle, first 16 characters: the registry's and @genui/sdk's bundle hash."""
    return hashlib.sha256(html.encode("utf-8")).hexdigest()[:16]


def bundle(name: str, html: str) -> ViewBundle:
    digest = content_hash(html)
    return ViewBundle(name=name, html=html, hash=digest, uri=f"ui://genui/{name}/{digest}")


def _asset(name: str) -> str:
    path = resources.files("genui") / "_assets" / name
    if not path.is_file():
        raise FileNotFoundError(
            f"genui asset {name} is missing. In the monorepo, build @genui/format and @genui/ui, "
            "then run `uv run python scripts/sync_assets.py`."
        )
    return path.read_text(encoding="utf-8")


@cache
def load_built_in_views() -> dict[str, ViewBundle]:
    """The built-in view bundles shipped with the package (read and hashed once per process)."""
    return {name: bundle(name, _asset(f"{name}.html")) for name in ("form", "chart")}


@cache
def _schema(name: str) -> str:
    return _asset(f"{name}.schema.json")


def tool_schema(name: Literal["form", "chart", "recipe-input"]) -> dict[str, Any]:
    """Input schema of a built-in tool, exported from @genui/format. A fresh copy on every call."""
    return json.loads(_schema(name))
