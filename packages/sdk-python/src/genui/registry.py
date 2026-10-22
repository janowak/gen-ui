"""Registry client: pulls catalogs and component bundles, keeps the last good version of each channel.

A port of `packages/sdk/src/registry.ts`. Polling runs on a daemon thread, so the client works the
same under `server.run()`, an ASGI server or an async main.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx2

from .meta import CHANNELS
from .views import content_hash

Listener = Callable[[str], None]


@dataclass(frozen=True)
class Snapshot:
    """A channel's catalog plus every bundle it references, fetched and hash-verified."""

    catalog: dict[str, Any]
    bundles: dict[str, str]

    def to_json(self) -> dict[str, Any]:
        return {"catalog": self.catalog, "bundles": self.bundles}


class RegistryClient:
    """Use `create_registry_client`. A failed refresh never replaces a working snapshot."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        refresh_seconds: float = 30,
        cache_file: str | Path | None = None,
        transport: httpx2.BaseTransport | None = None,
        timeout: float = 10,
        logger: logging.Logger | None = None,
    ) -> None:
        self._base = url.rstrip("/")
        self._headers = {"authorization": f"Bearer {token}"}
        self._transport = transport
        self._timeout = timeout
        self._cache_file = Path(cache_file) if cache_file else None
        self._logger = logger or logging.getLogger("genui")
        self._snapshots: dict[str, Snapshot] = {}
        self._listeners: list[Listener] = []
        self._refreshing = threading.RLock()
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._interval = refresh_seconds
        self._thread = threading.Thread(target=self._run, name="genui-registry", daemon=True)
        self._thread.start()

    def ready(self, timeout: float | None = None) -> bool:
        """Blocks until the first load attempt finished, successful or not."""
        return self._ready.wait(timeout)

    def snapshot(self, channel: str) -> Snapshot | None:
        """Last good snapshot for a channel, or None if none was ever loaded."""
        return self._snapshots.get(channel)

    def refresh(self) -> None:
        """Re-fetches every channel now. Listeners run on the calling thread."""
        with self._refreshing:
            ok = False
            with httpx2.Client(
                base_url=self._base, headers=self._headers, transport=self._transport, timeout=self._timeout
            ) as http:
                for channel in CHANNELS:
                    try:
                        self._load(http, channel)
                        ok = True
                    except Exception as error:  # keep serving the last good snapshot
                        self._logger.warning(
                            "[genui] registry %s refresh failed, keeping last good version: %s", channel, error
                        )
            if self._cache_file and ok:
                try:
                    data = {channel: snapshot.to_json() for channel, snapshot in self._snapshots.items()}
                    self._cache_file.write_text(json.dumps(data), encoding="utf-8")
                except OSError as error:
                    self._logger.warning("[genui] could not write cache: %s", error)

    def on_change(self, listener: Listener) -> Callable[[], None]:
        """Calls `listener(channel)` when a channel's snapshot changes. Returns an unsubscribe function."""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def close(self) -> None:
        """Stops polling."""
        self._closed.set()
        self._listeners.clear()

    def __enter__(self) -> RegistryClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _get(self, http: httpx2.Client, path: str, **params: str) -> httpx2.Response:
        response = http.get(path, params=params or None)
        if response.is_error:
            raise RuntimeError(f"{path}: HTTP {response.status_code}")
        return response

    def _load(self, http: httpx2.Client, channel: str) -> None:
        catalog = self._get(http, "/v1/catalog", channel=channel).json()
        previous = self._snapshots.get(channel)
        bundles: dict[str, str] = {}
        for component in catalog["components"]:
            digest = component["hash"]
            html = previous.bundles.get(digest) if previous else None
            if html is None:
                html = self._get(http, f"/v1/bundles/{digest}").content.decode("utf-8")
            if content_hash(html) != digest:
                raise RuntimeError(f"Bundle {component['name']}@{component['version']} failed hash verification")
            bundles[digest] = html
        if previous and previous.catalog == catalog:
            return
        self._snapshots[channel] = Snapshot(catalog=catalog, bundles=bundles)
        for listener in list(self._listeners):
            listener(channel)

    def _read_cache(self) -> None:
        if not self._cache_file:
            return
        try:
            data = json.loads(self._cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return  # No cache yet.
        for channel, snapshot in data.items():
            self._snapshots[channel] = Snapshot(catalog=snapshot["catalog"], bundles=snapshot["bundles"])

    def _run(self) -> None:
        try:
            self._read_cache()
            self.refresh()
        finally:
            self._ready.set()
        while self._interval > 0 and not self._closed.wait(self._interval):
            self.refresh()


def create_registry_client(
    url: str,
    token: str,
    *,
    refresh_seconds: float = 30,
    cache_file: str | Path | None = None,
    transport: httpx2.BaseTransport | None = None,
    timeout: float = 10,
    logger: logging.Logger | None = None,
) -> RegistryClient:
    """Pulls catalogs from the registry and keeps the last good version of each channel.

    Args:
        url: Registry base URL, e.g. https://registry.example.com
        token: Workspace server token (scope: server).
        refresh_seconds: Background refresh interval. 0 disables polling.
        cache_file: File where the last good snapshots are kept, so a restart works while the registry is down.
        transport: httpx2 transport, for tests.
        timeout: Per-request timeout in seconds.
    """
    return RegistryClient(
        url,
        token,
        refresh_seconds=refresh_seconds,
        cache_file=cache_file,
        transport=transport,
        timeout=timeout,
        logger=logger,
    )
