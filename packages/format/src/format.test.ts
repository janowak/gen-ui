import { describe, expect, it } from "vitest";
import { ChartSpec, FormSpec, SubmitResult, getPath, inlineSeries, rowsToSeries, toOptions } from "./index.js";

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
