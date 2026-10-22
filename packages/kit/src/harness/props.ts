/** Props form model built from the component's published JSON Schema. */

type Schema = Record<string, unknown>;

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export interface Field {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  options?: (string | number | boolean)[];
  min?: number;
  max?: number;
}

const asSchema = (value: unknown): Schema => (value && typeof value === "object" ? (value as Schema) : {});

function kindOf(schema: Schema): FieldKind {
  if (Array.isArray(schema.enum)) return "enum";
  switch (schema.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return schema.type;
    default:
      return "json"; // objects, arrays, unions: edited as JSON
  }
}

/** One form field per top-level prop, in schema order. */
export function fieldsOf(schema: unknown): Field[] {
  const root = asSchema(schema);
  const properties = asSchema(root.properties);
  const required = new Set(Array.isArray(root.required) ? root.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const prop = asSchema(value);
    const field: Field = { name, kind: kindOf(prop), required: required.has(name) };
    if (typeof prop.description === "string") field.description = prop.description;
    if (Array.isArray(prop.enum)) field.options = prop.enum as Field["options"];
    if (typeof prop.minimum === "number") field.min = prop.minimum;
    if (typeof prop.maximum === "number") field.max = prop.maximum;
    return field;
  });
}

const humanize = (name: string) => name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

function sample(name: string, schema: Schema): unknown {
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return `Example ${humanize(name)}`;
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return starterProps(schema);
    default:
      return null;
  }
}

/** Props to start from: every required prop with its default or a placeholder value. */
export function starterProps(schema: unknown): Record<string, unknown> {
  const root = asSchema(schema);
  const properties = asSchema(root.properties);
  const required = Array.isArray(root.required) ? (root.required as string[]) : [];
  return Object.fromEntries(required.filter((name) => name in properties).map((name) => [name, sample(name, asSchema(properties[name]))]));
}

/**
 * Growing prefixes of the props, the way a model streams tool arguments: one prop at a time,
 * strings word by word, arrays item by item.
 */
export function* partials(props: Record<string, unknown>): Generator<Record<string, unknown>> {
  const done: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string") {
      let text = "";
      for (const word of value.split(/(?<=\s)/)) yield { ...done, [key]: (text += word) };
    } else if (Array.isArray(value)) {
      for (let i = 1; i <= value.length; i++) yield { ...done, [key]: value.slice(0, i) };
    } else {
      yield { ...done, [key]: value };
    }
    done[key] = value;
  }
}
