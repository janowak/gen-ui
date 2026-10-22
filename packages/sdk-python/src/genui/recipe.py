"""Recipes: named, business-owned forms the model only picks and pre-fills.

`recipe_form` is a port of `recipeForm` in `packages/format/src/recipe.ts`.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .views import tool_schema

_DECIMAL = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


@cache
def _field_validator() -> Draft202012Validator:
    # One field of FormSpec.fields: the discriminated union over field types.
    return Draft202012Validator(tool_schema("form")["properties"]["fields"]["items"])


def _js_string(value: Any) -> str:
    """`String(value)` as JavaScript would write it, for the scalars a model sends."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, Mapping):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join("" if v is None else _js_string(v) for v in value)
    return str(value)


def _number(value: str) -> Any:
    text = value.strip()
    if not _DECIMAL.match(text):
        return value
    number = float(text)
    if not math.isfinite(number):
        return value
    return int(number) if number.is_integer() else number


def _coerce(field: Mapping[str, Any], value: Any) -> Any:
    kind = field.get("type")
    if kind == "number":
        return _number(value) if isinstance(value, str) and value.strip() != "" else value
    if kind in ("checkbox", "switch"):
        return True if value == "true" else False if value == "false" else value
    if kind == "multiselect":
        return [_js_string(v) for v in value] if isinstance(value, list) else [_js_string(value)]
    if kind == "resource_select":
        return {"id": value, "label": value} if isinstance(value, str) else value
    if kind == "resource_multiselect":
        items = value if isinstance(value, list) else [value]
        return [{"id": v, "label": v} if isinstance(v, str) else v for v in items]
    return _js_string(value) if isinstance(value, int | float) else value


def recipe_form(recipe: Mapping[str, Any], prefill: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The form a recipe renders, with pre-filled values as field defaults.

    Values that don't fit their field are ignored rather than breaking the form.
    """
    prefill = prefill or {}
    fields = []
    for field in recipe["form"]["fields"]:
        name = field["name"]
        if name not in prefill or prefill[name] is None:
            fields.append(field)
            continue
        candidate = {**field, "defaultValue": _coerce(field, prefill[name])}
        fields.append(candidate if _field_validator().is_valid(candidate) else field)
    return {**recipe["form"], "fields": fields}
