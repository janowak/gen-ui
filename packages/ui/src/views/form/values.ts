import type { Field, FormSpec, Option, SubmitValues } from "@genui/format";

/** Internal value per field. Selects keep the full option so labels survive re-renders and summaries. */
export type FieldState = string | number | boolean | string[] | Option | Option[] | undefined;
export type FormState = Record<string, FieldState>;

export function initialState(fields: Field[]): FormState {
  const state: FormState = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) state[field.name] = field.defaultValue;
    else if (field.type === "checkbox" || field.type === "switch") state[field.name] = false;
    else if (field.type === "multiselect" || field.type === "resource_multiselect") state[field.name] = [];
  }
  return state;
}

function isEmpty(value: FieldState): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side checks. The submit tool remains the source of truth. */
export function validate(fields: Field[], state: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = state[field.name];
    if (isEmpty(value)) {
      if (field.required && field.type !== "checkbox" && field.type !== "switch") errors[field.name] = "Required";
      continue;
    }
    if (field.required && (field.type === "checkbox" || field.type === "switch") && value !== true) {
      errors[field.name] = "Required";
      continue;
    }
    if (field.type === "text" || field.type === "textarea" || field.type === "email") {
      const text = String(value);
      if (field.type === "email" && !EMAIL.test(text)) errors[field.name] = "Enter a valid email";
      else if (field.minLength !== undefined && text.length < field.minLength) errors[field.name] = `At least ${field.minLength} characters`;
      else if (field.maxLength !== undefined && text.length > field.maxLength) errors[field.name] = `At most ${field.maxLength} characters`;
      else if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(text)) errors[field.name] = "Invalid format";
        } catch {
          // An invalid pattern from the model must not block the user.
        }
      }
    }
    if (field.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) errors[field.name] = "Enter a number";
      else if (field.min !== undefined && n < field.min) errors[field.name] = `Minimum ${field.min}`;
      else if (field.max !== undefined && n > field.max) errors[field.name] = `Maximum ${field.max}`;
    }
  }
  return errors;
}

/** Values sent to the submit tool: resource selects submit option ids. */
export function toSubmitValues(fields: Field[], state: FormState): SubmitValues {
  const values: SubmitValues = {};
  for (const field of fields) {
    const value = state[field.name];
    if (isEmpty(value)) continue;
    if (field.type === "resource_select") values[field.name] = (value as Option).id;
    else if (field.type === "resource_multiselect") values[field.name] = (value as Option[]).map((o) => o.id);
    else if (field.type === "number") values[field.name] = Number(value);
    else values[field.name] = value as string | boolean | string[];
  }
  return values;
}

function display(field: Field, value: FieldState): string {
  if (field.type === "resource_select") return `${(value as Option).label} (id ${(value as Option).id})`;
  if (field.type === "resource_multiselect") return (value as Option[]).map((o) => `${o.label} (id ${o.id})`).join(", ");
  if (field.type === "select" || field.type === "radio") return field.options.find((o) => o.id === value)?.label ?? String(value);
  if (field.type === "multiselect") return (value as string[]).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(", ");
  return String(value);
}

/** Human-readable summary for the model's context. */
export function summarize(spec: FormSpec, state: FormState, outcome?: string): string {
  const lines = [`The user submitted the form${spec.title ? ` "${spec.title}"` : ""}:`];
  for (const field of spec.fields) {
    const value = state[field.name];
    if (!isEmpty(value)) lines.push(`- ${field.label}: ${display(field, value)}`);
  }
  if (outcome) lines.push("", `Result: ${outcome}`);
  return lines.join("\n");
}
