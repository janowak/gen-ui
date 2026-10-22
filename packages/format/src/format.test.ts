import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtInJsonSchemas, ChartSpec, FormSpec, Recipe, SubmitResult, getPath, inlineSeries, recipeForm, rowsToSeries, toOptions } from "./index.js";

describe("getPath", () => {
  it("reads nested and indexed paths", () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, "a.b.0.c")).toBe(1);
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath([1, 2], undefined)).toEqual([1, 2]);
  });
});

describe("toOptions", () => {
  it("maps items with id and label paths", () => {
    const result = { data: { products: [{ sku: 1, title: "Mug" }, { sku: "2" }, { title: "no id" }] } };
    expect(toOptions(result, { itemsPath: "data.products", idPath: "sku", labelPath: "title" })).toEqual([
      { id: "1", label: "Mug" },
      { id: "2", label: "2" },
    ]);
  });
});

describe("charts", () => {
  it("maps rows with x and series", () => {
    const data = rowsToSeries([{ m: "Jan", v: 10 }, { m: "Feb", v: "12" }, { m: "Mar", v: null }], {
      x: "m",
      series: [{ path: "v", name: "Revenue" }],
    });
    expect(data.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(data.series[0]).toMatchObject({ name: "Revenue", values: [10, 12, null] });
  });

  it("normalizes all inline modes and skips source mode", () => {
    const rows = ChartSpec.parse({ type: "line", data: { rows: [{ w: "W1", s: 1 }] }, x: "w", series: [{ path: "s" }] });
    const series = ChartSpec.parse({ type: "pie", data: { categories: ["A"], series: [{ name: "n", values: [1] }] } });
    const source = ChartSpec.parse({ type: "bar", data: { source: { toolName: "t" } } });
    expect(inlineSeries(rows)?.series[0]?.values).toEqual([1]);
    expect(inlineSeries(series)?.categories).toEqual(["A"]);
    expect(inlineSeries(source)).toBeNull();
  });
});

describe("schemas", () => {
  it("parses a form with resource selects and applies idPath default", () => {
    const form = FormSpec.parse({
      fields: [
        { name: "c", label: "Customer", type: "resource_select", source: { toolName: "search", labelPath: "name" } },
        { name: "p", label: "Priority", type: "select", options: [{ id: "1", label: "Low" }] },
      ],
    });
    const field = form.fields[0];
    expect(field?.type === "resource_select" && field.source.idPath).toBe("id");
  });

  it("validates submit results", () => {
    expect(SubmitResult.safeParse({ ok: false, fieldErrors: { email: "taken" } }).success).toBe(true);
    expect(SubmitResult.safeParse({ ok: "yes" }).success).toBe(false);
  });
});

describe("recipes", () => {
  const recipe = Recipe.parse({
    name: "add_item",
    when: "The user wants to add an item.",
    form: {
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "price", label: "Price", type: "number" },
        { name: "category", label: "Category", type: "resource_select", source: { toolName: "list_categories", labelPath: "name" } },
        { name: "tags", label: "Tags", type: "multiselect", options: [{ id: "new", label: "New" }] },
      ],
      submit: { toolName: "create_item" },
    },
  });

  it("pre-fills fields with light coercion and ignores values that don't fit", () => {
    const form = recipeForm(recipe, { name: "Mug", price: "12", category: "c-1", tags: "new", unknown: 1 });
    const byName = Object.fromEntries(form.fields.map((f) => [f.name, f.defaultValue]));
    expect(byName).toEqual({ name: "Mug", price: 12, category: { id: "c-1", label: "c-1" }, tags: ["new"] });
    expect(recipeForm(recipe, { price: "not a number" }).fields[1]?.defaultValue).toBeUndefined();
    expect(form.submit?.toolName).toBe("create_item");
  });

  it("rejects bad recipe names", () => {
    expect(Recipe.safeParse({ ...recipe, name: "Add Item" }).success).toBe(false);
  });
});

describe("JSON schemas", () => {
  it("are object schemas, and the files the build wrote are current", () => {
    for (const [name, schema] of Object.entries(builtInJsonSchemas())) {
      expect(schema.type).toBe("object");
      const file = JSON.parse(readFileSync(new URL(`../schemas/${name}.json`, import.meta.url), "utf8"));
      expect(file, `schemas/${name}.json is stale: run pnpm --filter @genui/format build`).toEqual(schema);
    }
  });
});
