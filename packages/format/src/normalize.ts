import type { ChartSpec, SeriesData } from "./chart.js";
import type { Option, ResourceSource } from "./form.js";
import { getItems, getPath } from "./path.js";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Maps rows with `x` and `series` into chart data. */
export function rowsToSeries(rows: unknown[], spec: Pick<ChartSpec, "x" | "series">): SeriesData {
  const mappings = spec.series ?? [];
  return {
    categories: rows.map((row, i) => String(getPath(row, spec.x) ?? i + 1)),
    series: mappings.map((m, i) => ({
      key: `s${i}`,
      name: m.name ?? m.path,
      values: rows.map((row) => toNumber(getPath(row, m.path))),
      format: m.format,
      unit: m.unit,
    })),
  };
}

/** Normalizes inline chart data. Returns null for source mode, which needs a fetch first. */
export function inlineSeries(spec: ChartSpec): SeriesData | null {
  const { data } = spec;
  if ("rows" in data) return rowsToSeries(data.rows, spec);
  if ("categories" in data) {
    return {
      categories: data.categories,
      series: data.series.map((s, i) => ({
        key: `s${i}`,
        name: s.name,
        values: s.values,
        format: spec.series?.[i]?.format,
        unit: spec.series?.[i]?.unit,
      })),
    };
  }
  return null;
}

/** Turns a tool result into select options using the source's paths. */
export function toOptions(toolResult: unknown, source: Pick<ResourceSource, "itemsPath" | "idPath" | "labelPath">): Option[] {
  return getItems(toolResult, source.itemsPath).flatMap((item) => {
    const id = getPath(item, source.idPath ?? "id");
    const label = getPath(item, source.labelPath);
    if (id == null) return [];
    return [{ id: String(id), label: label == null ? String(id) : String(label) }];
  });
}
