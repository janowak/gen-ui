import type { Field } from "@app-mcp/format";
import { describe, expect, it } from "vitest";
import { begin, fail, finish, restoreValues, submitStatus, type SavedForm } from "./saved";

const fields: Field[] = [
  { name: "name", label: "Name", type: "text", defaultValue: "Mug" },
  { name: "gift", label: "Gift", type: "checkbox" },
  { name: "tags", label: "Tags", type: "multiselect", options: [{ id: "a", label: "A" }] },
];

describe("saved form", () => {
  it("restores a draft over the defaults, for the fields the form has", () => {
    expect(restoreValues(fields, undefined)).toEqual({ name: "Mug", gift: false, tags: [] });
    expect(restoreValues(fields, { name: "Cup", gift: true, gone: "x" })).toEqual({ name: "Cup", gift: true, tags: [] });
  });

  it("goes open → pending → done, and drops the answers once done", () => {
    let saved: SavedForm = { values: { name: "Cup" } };
    expect(submitStatus(saved, "view-a")).toBe("open");

    saved = begin(saved, "view-a");
    expect(submitStatus(saved, "view-a")).toBe("pending");
    expect(saved.values).toEqual({ name: "Cup" });

    saved = finish("Order #1042 created", "view-a");
    expect(submitStatus(saved, "view-b")).toBe("done");
    expect(saved).toEqual({ submit: { status: "done", by: "view-a", message: "Order #1042 created", at: expect.any(Number) } });
  });

  it("reads a pending submit from another view as interrupted", () => {
    const saved = begin({ values: { name: "Cup" } }, "view-a");
    expect(submitStatus(saved, "view-b")).toBe("interrupted");
  });

  it("goes back to open with the answers kept when the submit fails", () => {
    const saved = fail(begin({ values: { name: "Cup" } }, "view-a"));
    expect(saved).toEqual({ values: { name: "Cup" } });
    expect(submitStatus(saved, "view-a")).toBe("open");
  });
});
