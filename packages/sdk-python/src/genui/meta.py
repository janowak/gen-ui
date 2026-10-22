"""The genui view contract: keys the SDK sets in a render tool result's `_meta`.

Mirrors `packages/format/src/meta.ts`; keep the two in sync.
"""

PREVIEW_META_KEY = "genui/preview"
"""Set on registry previews: the view renders without calling tools."""

THEME_META_KEY = "genui/theme"
"""The current workspace theme."""

VIEW_ID_META_KEY = "genui/viewId"
"""Stable id of one render. Hosts replay stored results, so a re-rendered message gets the same id."""

FORM_META_KEY = "genui/form"
"""Key under which use_recipe returns the built form in the result's `_meta`; the form view renders it."""

COMPONENT_CONTRACT = 1
"""Component contract version this SDK serves. Components that need a newer one are skipped."""

CHANNELS = ("beta", "stable")
"""Registry channels."""

RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
"""MIME type of `ui://` view resources (MCP Apps)."""
