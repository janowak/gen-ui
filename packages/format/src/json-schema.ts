import { z } from "zod";
import { ChartSpec } from "./chart.js";
import { FormSpec } from "./form.js";
import { RecipeInput } from "./recipe.js";

/**
 * A tool input schema as JSON Schema 2020-12, converted the way the MCP TypeScript SDK converts
 * zod schemas, so SDKs in other languages advertise exactly what @genui/sdk does.
 */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  return { type: "object", ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) };
}

/** Input schemas of the built-in tools, written to `schemas/<name>.json` by the build. */
export function builtInJsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    form: toolInputSchema(FormSpec),
    chart: toolInputSchema(ChartSpec),
    "recipe-input": toolInputSchema(RecipeInput),
  };
}
