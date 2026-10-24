"""genui demo server in Python: the mock company tools of apps/demo plus mount_genui.

genui's tools come from the registry's end-user MCP (a server token: `genui token server demo`):

    GENUI_MCP_URL=http://localhost:4000/w/<workspace>/mcp GENUI_MCP_TOKEN=... uv run python examples/demo_server.py

The URL picks the environment: /w/<workspace>/<environment>/mcp for one other than prod. Then open the
playground against it:
http://localhost:5173/?server=http://localhost:3002/mcp
"""

from __future__ import annotations

import os
import random
from datetime import date
from typing import Annotated, Any

import anyio
import uvicorn
from mcp.server.mcpserver import MCPServer
from pydantic import Field
from starlette.middleware.cors import CORSMiddleware

from genui import connect_genui, mount_genui

PORT = int(os.environ.get("PORT", "3002"))

server = MCPServer("genui-demo-python", version="0.1.0")

# Mock "company" tools: what a real server would already expose before adding genui.

CUSTOMERS = [
    {"id": "c-1", "name": "Acme Corp", "country": "DE"},
    {"id": "c-2", "name": "Globex", "country": "US"},
    {"id": "c-3", "name": "Initech (on hold)", "country": "US"},
    {"id": "c-4", "name": "Umbrella", "country": "UK"},
    {"id": "c-5", "name": "Hooli", "country": "US"},
    {"id": "c-6", "name": "Stark Industries", "country": "US"},
    {"id": "c-7", "name": "Wayne Enterprises", "country": "US"},
    {"id": "c-8", "name": "Wonka Industries", "country": "UK"},
]

PRODUCTS = [
    {"sku": "MUG-01", "title": "Ceramic mug", "price": 12},
    {"sku": "TEE-02", "title": "Logo t-shirt", "price": 25},
    {"sku": "CAP-03", "title": "Baseball cap", "price": 18},
    {"sku": "BAG-04", "title": "Tote bag", "price": 15},
    {"sku": "PEN-05", "title": "Metal pen", "price": 6},
]

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

next_order = 1042


@server.tool(description="Search customers by name. Returns { items: [{ id, name, country }] }.")
async def search_customers(query: str | None = None, country: str | None = None) -> dict[str, Any]:
    await anyio.sleep(0.3)  # simulate a real backend so loading states are visible
    q = (query or "").lower()
    return {"items": [c for c in CUSTOMERS if q in c["name"].lower() and (not country or c["country"] == country)]}


@server.tool(description="List products. Returns { data: { products: [{ sku, title, price }] } }.")
async def list_products(q: str | None = None) -> dict[str, Any]:
    await anyio.sleep(0.2)
    return {"data": {"products": [p for p in PRODUCTS if (q or "").lower() in p["title"].lower()]}}


@server.tool(description="Create an order. Returns { ok: true, message, result } or { ok: false, fieldErrors?, formError? }.")
async def create_order(
    customer: str,
    products: list[str] | None = None,
    priority: str | None = None,
    delivery_date: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    global next_order
    await anyio.sleep(0.5)
    field_errors: dict[str, str] = {}
    if not products:
        field_errors["products"] = "Pick at least one product"
    if delivery_date and date.fromisoformat(delivery_date) < date.today():
        field_errors["delivery_date"] = "Must be today or later"
    if field_errors:
        return {"ok": False, "fieldErrors": field_errors}
    if customer == "c-3":
        return {"ok": False, "formError": "Initech's account is on hold. Contact finance."}
    order_id = next_order
    next_order += 1
    print(f"[demo] order #{order_id} created for {customer}: {products}")
    return {"ok": True, "message": f"Order #{order_id} created", "result": {"orderId": order_id}}


@server.tool(description="Store a 1-5 star rating. Used by the rating component.")
async def save_rating(
    stars: Annotated[int, Field(ge=1, le=10)], question: str | None = None, subject: str | None = None
) -> dict[str, Any]:
    await anyio.sleep(0.3)
    print(f'[demo] rating saved: {stars}/5 for "{question or "?"}"')
    return {"ok": True, "message": f"Saved {stars}/5"}


@server.tool(description="Monthly revenue and costs for a year. Returns { rows: [{ month, revenue, costs }] }.")
async def get_revenue(year: int) -> dict[str, Any]:
    await anyio.sleep(0.4)

    def jitter() -> int:
        return round((random.random() - 0.5) * 4000)

    rows = [
        {"month": month, "revenue": 40000 + i * 2500 + (year % 7) * 1000 + jitter(), "costs": 30000 + i * 1200 + jitter()}
        for i, month in enumerate(MONTHS)
    ]
    return {"rows": rows}


def main() -> None:
    url = os.environ.get("GENUI_MCP_URL")
    if url:
        genui = connect_genui(url, os.environ.get("GENUI_MCP_TOKEN", ""), refresh_seconds=10)
        # This server is long-lived, so it can follow genui releases and tell clients about them.
        mount_genui(server, genui, watch=True)
    else:
        print("GENUI_MCP_URL is not set: serving the company tools only.")

    app = server.streamable_http_app()
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["mcp-session-id"]
    )
    print(f"genui Python demo MCP server on http://localhost:{PORT}/mcp" + (f" (genui: {url})" if url else ""))
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
