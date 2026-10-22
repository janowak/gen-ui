/** Example tool calls, as a model would make them. */
export const PRESETS: Record<string, { tool: string; args: Record<string, unknown> }> = {
  "Order form (resource selects + submit)": {
    tool: "render_form",
    args: {
      title: "New order",
      description: "Pick a customer and products. Validation runs on submit.",
      fields: [
        {
          name: "customer",
          label: "Customer",
          type: "resource_select",
          required: true,
          placeholder: "Search customers…",
          source: { toolName: "search_customers", searchParam: "query", itemsPath: "items", idPath: "id", labelPath: "name" },
        },
        {
          name: "products",
          label: "Products",
          type: "resource_multiselect",
          source: { toolName: "list_products", searchParam: "q", itemsPath: "data.products", idPath: "sku", labelPath: "title" },
        },
        {
          name: "priority",
          label: "Priority",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "normal", label: "Normal" },
            { id: "high", label: "High" },
          ],
          defaultValue: "normal",
        },
        { name: "delivery_date", label: "Delivery date", type: "date" },
        { name: "notes", label: "Notes", type: "textarea", maxLength: 500 },
      ],
      submit: { toolName: "create_order", label: "Create order" },
    },
  },
  "Feedback form (no submit tool)": {
    tool: "render_form",
    args: {
      title: "Quick feedback",
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        { name: "score", label: "Score (1-10)", type: "number", min: 1, max: 10 },
        {
          name: "topics",
          label: "Topics",
          type: "multiselect",
          options: [
            { id: "ux", label: "UX" },
            { id: "perf", label: "Performance" },
            { id: "docs", label: "Docs" },
          ],
        },
        { name: "plan", label: "Plan", type: "radio", options: [{ id: "free", label: "Free" }, { id: "pro", label: "Pro" }] },
        { name: "contact", label: "You may contact me", type: "switch" },
        { name: "terms", label: "I accept the terms", type: "checkbox", required: true },
      ],
    },
  },
  "Revenue (source + refresh)": {
    tool: "render_chart",
    args: {
      type: "bar",
      title: "Revenue vs costs 2026",
      x: "month",
      series: [
        { path: "revenue", name: "Revenue", format: "currency", unit: "EUR" },
        { path: "costs", name: "Costs", format: "currency", unit: "EUR" },
      ],
      data: { source: { toolName: "get_revenue", params: { year: 2026 }, itemsPath: "rows" } },
      refreshSeconds: 10,
    },
  },
  "Signups (inline rows)": {
    tool: "render_chart",
    args: {
      type: "line",
      title: "Weekly signups",
      x: "week",
      series: [
        { path: "signups", name: "Signups" },
        { path: "churned", name: "Churned" },
      ],
      data: {
        rows: Array.from({ length: 12 }, (_, i) => ({ week: `W${i + 1}`, signups: 100 + i * 12 + (i % 3) * 9, churned: 20 + (i % 4) * 3 })),
      },
    },
  },
  "Plan mix (inline series, donut)": {
    tool: "render_chart",
    args: { type: "donut", title: "Accounts by plan", data: { categories: ["Free", "Pro", "Team", "Enterprise"], series: [{ name: "Accounts", values: [620, 210, 70, 12] }] } },
  },
  "Rating (registry component)": {
    tool: "render_rating",
    args: { question: "How was your last order?", subject: "order-1042" },
  },
  "Recipe: create_order (pre-filled)": {
    tool: "use_recipe",
    args: { recipe: "create_order", prefill: { customer: { id: "c-2", label: "Globex" }, priority: "high", notes: "Gift wrap" } },
  },
  "Registry: manage components": { tool: "manage_components", args: {} },
  "Registry: theme controller": { tool: "open_theme_controller", args: {} },
  "Registry: preview rating (beta)": { tool: "preview_rating", args: { question: "Preview: how was it?" } },
};
