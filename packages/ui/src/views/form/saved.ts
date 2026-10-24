import type { Field } from "@genui/format";
import { initialState, type FormState } from "./values";

/** What the form keeps per render (`useViewState`): the draft, then how the submit went. */
export interface SavedForm {
  /** The draft. Dropped once the form is submitted. */
  values?: FormState;
  submit?: { status: "pending" | "done"; by: string; message?: string; at: number };
}

/**
 * - `open`: not submitted, or a submit failed and can be retried.
 * - `pending`: this view is submitting.
 * - `done`: submitted; `message` is what the user saw.
 * - `interrupted`: an earlier view of this render started a submit and closed before it finished,
 *   so it may or may not have gone through.
 */
export type SubmitStatus = "open" | "pending" | "done" | "interrupted";

/** This view instance. A pending submit written by another instance never finished there. */
export const VIEW_INSTANCE = Math.random().toString(36).slice(2);

export function submitStatus(saved: SavedForm, instance = VIEW_INSTANCE): SubmitStatus {
  if (!saved.submit) return "open";
  if (saved.submit.status === "done") return "done";
  return saved.submit.by === instance ? "pending" : "interrupted";
}

/** Before calling the submit tool: keeps the values. */
export function begin(saved: SavedForm, instance = VIEW_INSTANCE): SavedForm {
  return { ...saved, submit: { status: "pending", by: instance, at: Date.now() } };
}

/** Submitted: only the message stays, so the answers aren't kept longer than needed. */
export function finish(message: string, instance = VIEW_INSTANCE): SavedForm {
  return { submit: { status: "done", by: instance, message, at: Date.now() } };
}

/** The submit failed or was rejected: back to editing, values kept. */
export function fail(saved: SavedForm): SavedForm {
  return { values: saved.values };
}

/** Defaults (and the model's prefill) overlaid with saved values for the fields the form has. */
export function restoreValues(fields: Field[], values: FormState | undefined): FormState {
  const state = initialState(fields);
  for (const field of fields) if (values && field.name in values) state[field.name] = values[field.name];
  return state;
}
