import { z } from "zod";

export const ToolParams = z
  .record(z.string(), z.unknown())
  .describe("Arguments passed to the tool. Fill every parameter the tool requires.");

export const ResourceSource = z
  .object({
    toolName: z.string().describe("Tool on this server that returns the options."),
    params: ToolParams.optional(),
    searchParam: z
      .string()
      .optional()
      .describe("Tool parameter that receives the text the user types. Omit if the tool has no search."),
    itemsPath: z
      .string()
      .optional()
      .describe('Dot path to the options array in the tool result, e.g. "items" or "data.products". Omit if the result is the array.'),
    idPath: z.string().default("id").describe("Dot path to the option id inside each item."),
    labelPath: z.string().describe("Dot path to the option label inside each item."),
  })
  .describe("Loads options by calling a tool.");
export type ResourceSource = z.infer<typeof ResourceSource>;

export const Option = z.object({ id: z.string(), label: z.string() });
export type Option = z.infer<typeof Option>;

const base = {
  name: z.string().describe("Key of this field in the submitted values."),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
};

const placeholder = { placeholder: z.string().optional() };

export const TextField = z.object({
  ...base,
  ...placeholder,
  type: z.enum(["text", "textarea", "email"]),
  defaultValue: z.string().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  pattern: z.string().optional().describe("Regular expression the value must match."),
});

export const NumberField = z.object({
  ...base,
  ...placeholder,
  type: z.literal("number"),
  defaultValue: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

export const DateField = z.object({
  ...base,
  type: z.literal("date"),
  defaultValue: z.string().optional().describe("ISO date, YYYY-MM-DD."),
});

export const BooleanField = z.object({
  ...base,
  type: z.enum(["checkbox", "switch"]),
  defaultValue: z.boolean().optional(),
});

export const ChoiceField = z.object({
  ...base,
  ...placeholder,
  type: z.enum(["radio", "select"]),
  options: z.array(Option).min(1),
  defaultValue: z.string().optional(),
});

export const MultiChoiceField = z.object({
  ...base,
  ...placeholder,
  type: z.literal("multiselect"),
  options: z.array(Option).min(1),
  defaultValue: z.array(z.string()).optional(),
});

export const ResourceSelectField = z.object({
  ...base,
  ...placeholder,
  type: z.literal("resource_select"),
  source: ResourceSource,
  defaultValue: Option.optional(),
});

export const ResourceMultiSelectField = z.object({
  ...base,
  ...placeholder,
  type: z.literal("resource_multiselect"),
  source: ResourceSource,
  defaultValue: z.array(Option).optional(),
});

export const Field = z.discriminatedUnion("type", [
  TextField,
  NumberField,
  DateField,
  BooleanField,
  ChoiceField,
  MultiChoiceField,
  ResourceSelectField,
  ResourceMultiSelectField,
]);
export type Field = z.infer<typeof Field>;
export type FieldType = Field["type"];

export const SubmitAction = z
  .object({
    toolName: z.string().describe("Tool on this server called with the form values when the user submits."),
    params: ToolParams.optional().describe("Fixed arguments merged with the form values."),
    label: z.string().optional().describe("Submit button text."),
  })
  .describe("Omit to return the submitted values to the conversation instead of calling a tool.");
export type SubmitAction = z.infer<typeof SubmitAction>;

export const FormSpec = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(Field).min(1),
  submit: SubmitAction.optional(),
});
export type FormSpec = z.infer<typeof FormSpec>;

/** Shape a submit tool must return in `structuredContent`. */
export const SubmitResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: z.string().optional(), result: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    fieldErrors: z.record(z.string(), z.string()).optional(),
    formError: z.string().optional(),
  }),
]);
export type SubmitResult = z.infer<typeof SubmitResult>;

/** Values sent to the submit tool. Resource selects submit option ids. */
export type SubmitValue = string | number | boolean | string[] | undefined;
export type SubmitValues = Record<string, SubmitValue>;
