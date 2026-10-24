import { z } from "zod";
import { Field, FormSpec } from "./form.js";

export const RecipeName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase letters, digits and _; also the slash command name");

/**
 * A named, business-owned form: the fields, validation and tools are fixed; the model only picks
 * the recipe and pre-fills values. `when` and `notes` are plain text that guide the model.
 */
export const Recipe = z.object({
  name: RecipeName,
  title: z.string().optional().describe("Shown as the slash command title."),
  when: z.string().min(1).describe('When to use it, e.g. "The user wants to add a catalog item."'),
  form: FormSpec,
  notes: z.string().optional().describe("Extra guidance for the model, e.g. what to pre-fill or never ask."),
  validate: z
    .object({
      url: z
        .url({ protocol: /^https?$/ })
        .describe(
          "Webhook that receives { recipe, viewId, values } (signed; viewId is the same for every submit of one rendered form) and replies { ok, fieldErrors?, formError?, message? }.",
        ),
    })
    .optional()
    .describe("Hosted MCP: check the values with the company's webhook before they reach the model."),
});
export type Recipe = z.infer<typeof Recipe>;

/** Values the model may pre-fill, keyed by field name. Resource selects take { id, label } or an id. */
export const RecipePrefill = z.record(z.string(), z.unknown());
export type RecipePrefill = z.infer<typeof RecipePrefill>;

/** Arguments of the use_recipe tool. The SDK narrows `recipe` to the workspace's recipe names. */
export const RecipeInput = z.object({
  recipe: z.string(),
  prefill: RecipePrefill.optional().describe("Known values keyed by field name. Selects take an option id; tool-backed selects take { id, label }."),
});
export type RecipeInput = z.infer<typeof RecipeInput>;

function coerce(field: Field, value: unknown): unknown {
  switch (field.type) {
    case "number":
      return typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    case "checkbox":
    case "switch":
      return value === "true" ? true : value === "false" ? false : value;
    case "multiselect":
      return Array.isArray(value) ? value.map(String) : [String(value)];
    case "resource_select":
      return typeof value === "string" ? { id: value, label: value } : value;
    case "resource_multiselect":
      return (Array.isArray(value) ? value : [value]).map((v) => (typeof v === "string" ? { id: v, label: v } : v));
    default:
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
  }
}

/**
 * The form a recipe renders, with pre-filled values as field defaults.
 * Values that don't fit their field are ignored rather than breaking the form.
 */
export function recipeForm(recipe: Recipe, prefill: RecipePrefill = {}): FormSpec {
  const fields = recipe.form.fields.map((field) => {
    if (!(field.name in prefill) || prefill[field.name] == null) return field;
    const candidate = Field.safeParse({ ...field, defaultValue: coerce(field, prefill[field.name]) });
    return candidate.success ? candidate.data : field;
  });
  return { ...recipe.form, fields };
}
