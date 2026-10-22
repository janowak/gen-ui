import { z } from "zod";
import { ToolParams } from "./form.js";

export const ChartType = z.enum(["line", "bar", "area", "pie", "donut"]);
export type ChartType = z.infer<typeof ChartType>;

export const ValueFormat = z.enum(["number", "currency", "percent"]);
export type ValueFormat = z.infer<typeof ValueFormat>;

export const SeriesMapping = z.object({
  path: z.string().describe("Dot path to the numeric value inside each row."),
  name: z.string().optional(),
  format: ValueFormat.optional(),
  unit: z.string().optional().describe('Currency code for "currency" (e.g. "EUR"), or a suffix such as "ms".'),
});
export type SeriesMapping = z.infer<typeof SeriesMapping>;

export const InlineRows = z
  .object({ rows: z.array(z.record(z.string(), z.unknown())) })
  .describe("Rows you already have. Map them with `x` and `series`.");

export const InlineSeries = z
  .object({
    categories: z.array(z.string()),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1),
  })
  .describe("Chart-native data for small hand-built charts. No mapping needed.");

export const ChartSource = z
  .object({
    toolName: z.string().describe("Tool on this server that returns the rows."),
    params: ToolParams.optional(),
    itemsPath: z.string().optional().describe("Dot path to the rows array in the tool result. Omit if the result is the array."),
  })
  .describe("The chart fetches rows itself. Use for large (~200+ rows) or live data. Map rows with `x` and `series`.");

export const ChartData = z.union([InlineRows, InlineSeries, z.object({ source: ChartSource })]);
export type ChartData = z.infer<typeof ChartData>;

// Property order matters: models write arguments in schema order, so `x` and `series`
// stream before `data` and the chart can draw rows progressively.
export const ChartSpec = z.object({
  type: ChartType,
  title: z.string().optional(),
  description: z.string().optional(),
  x: z.string().optional().describe("Dot path to the category / x value in each row (rows and source modes)."),
  series: z.array(SeriesMapping).optional().describe("Values to plot from each row (rows and source modes)."),
  data: ChartData,
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional().describe("Bar charts only."),
  refreshSeconds: z.number().int().min(5).optional().describe("Source mode only: re-fetch interval."),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

/** Normalized data every chart renders from. */
export interface SeriesData {
  categories: string[];
  series: { key: string; name: string; values: (number | null)[]; format?: ValueFormat; unit?: string }[];
}
