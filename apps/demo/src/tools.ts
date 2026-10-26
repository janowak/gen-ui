import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Mock "company" tools: what a real server would already expose before adding genui. */

const CUSTOMERS = [
  { id: "c-1", name: "Acme Corp", country: "DE" },
  { id: "c-2", name: "Globex", country: "US" },
  { id: "c-3", name: "Initech (on hold)", country: "US" },
  { id: "c-4", name: "Umbrella", country: "UK" },
  { id: "c-5", name: "Hooli", country: "US" },
  { id: "c-6", name: "Stark Industries", country: "US" },
  { id: "c-7", name: "Wayne Enterprises", country: "US" },
  { id: "c-8", name: "Wonka Industries", country: "UK" },
];

const PRODUCTS = [
  { sku: "MUG-01", title: "Ceramic mug", price: 12 },
  { sku: "TEE-02", title: "Logo t-shirt", price: 25 },
  { sku: "CAP-03", title: "Baseball cap", price: 18 },
  { sku: "BAG-04", title: "Tote bag", price: 15 },
  { sku: "PEN-05", title: "Metal pen", price: 6 },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function json(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextOrder = 1042;
/** Results by idempotency key (the view's render id), so a repeated submit returns the first result. */
const ratings = new Map<string, Record<string, unknown>>();
const orders = new Map<string, Record<string, unknown>>();

export function registerCompanyTools(server: McpServer): void {
  server.registerTool(
    "search_customers",
    {
      description: "Search customers by name. Returns { items: [{ id, name, country }] }.",
      inputSchema: z.object({ query: z.string().optional(), country: z.string().optional() }),
    },
    async ({ query, country }) => {
      await delay(300); // simulate a real backend so loading states are visible
      const q = query?.toLowerCase() ?? "";
      const items = CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q) && (!country || c.country === country));
      return json({ items });
    },
  );

  server.registerTool(
    "list_products",
    {
      description: "List products. Returns { data: { products: [{ sku, title, price }] } }.",
      inputSchema: z.object({ q: z.string().optional() }),
    },
    async ({ q }) => {
      await delay(200);
      const products = PRODUCTS.filter((p) => p.title.toLowerCase().includes(q?.toLowerCase() ?? ""));
      return json({ data: { products } });
    },
  );

  server.registerTool(
    "create_order",
    {
      description: "Create an order. Returns { ok: true, message, result } or { ok: false, fieldErrors?, formError? }.",
      inputSchema: z.object({
        customer: z.string(),
        products: z.array(z.string()).optional(),
        priority: z.string().optional(),
        delivery_date: z.string().optional(),
        notes: z.string().optional(),
        request_id: z.string().optional().describe("Idempotency key: a repeated request returns the first result."),
      }),
    },
    async ({ customer, products, delivery_date, request_id }) => {
      const earlier = request_id ? orders.get(request_id) : undefined;
      if (earlier) return json(earlier);
      await delay(500);
      const fieldErrors: Record<string, string> = {};
      if (!products?.length) fieldErrors.products = "Pick at least one product";
      if (delivery_date && new Date(delivery_date) < new Date(new Date().toDateString()))
        fieldErrors.delivery_date = "Must be today or later";
      if (Object.keys(fieldErrors).length) return json({ ok: false, fieldErrors });
      if (customer === "c-3") return json({ ok: false, formError: "Initech's account is on hold. Contact finance." });
      const orderId = nextOrder++;
      const result = { ok: true, message: `Order #${orderId} created`, result: { orderId } };
      if (request_id) orders.set(request_id, result);
      return json(result);
    },
  );

  server.registerTool(
    "save_rating",
    {
      description: "Store a 1-5 star rating. Used by the rating component.",
      inputSchema: z.object({
        stars: z.number().int().min(1).max(10),
        question: z.string().optional(),
        subject: z.string().optional(),
        request_id: z.string().optional().describe("Idempotency key: a repeated request returns the first result."),
      }),
    },
    async ({ stars, question, request_id }) => {
      const earlier = request_id ? ratings.get(request_id) : undefined;
      if (earlier) return json(earlier);
      await delay(300);
      console.log(`[demo] rating saved: ${stars}/5 for "${question ?? "?"}"`);
      const result = { ok: true, message: `Saved ${stars}/5` };
      if (request_id) ratings.set(request_id, result);
      return json(result);
    },
  );

  server.registerTool(
    "get_revenue",
    {
      description: "Monthly revenue and costs for a year. Returns { rows: [{ month, revenue, costs }] }.",
      inputSchema: z.object({ year: z.number().int() }),
    },
    async ({ year }) => {
      await delay(400);
      const jitter = () => Math.round((Math.random() - 0.5) * 4000);
      const rows = MONTHS.map((month, i) => ({
        month,
        revenue: 40000 + i * 2500 + (year % 7) * 1000 + jitter(),
        costs: 30000 + i * 1200 + jitter(),
      }));
      return json({ rows });
    },
  );
}
