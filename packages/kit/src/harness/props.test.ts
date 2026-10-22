import { describe, expect, it } from "vitest";
import { toManifest } from "../define.js";
import { defineComponent, z } from "../index.js";
import { fieldsOf, partials, starterProps } from "./props.js";

const schema = toManifest(
  defineComponent({
    name: "pay_range",
    version: "1.0.0",
    description: "Pay band.",
    props: z.object({
      roleTitle: z.string().describe("Role shown above the band."),
      currency: z.enum(["EUR", "USD"]),
      min: z.number().int().min(1000),
      remote: z.boolean(),
      period: z.enum(["year", "month"]).default("year"),
      note: z.string().optional(),
      markers: z.array(z.object({ label: z.string(), value: z.number() })).optional(),
    }),
  }),
).props;

describe("props form model", () => {
  it("makes one field per prop with its kind, bounds and options", () => {
    expect(fieldsOf(schema)).toEqual([
      { name: "roleTitle", kind: "string", required: true, description: "Role shown above the band." },
      { name: "currency", kind: "enum", required: true, options: ["EUR", "USD"] },
      { name: "min", kind: "integer", required: true, min: 1000, max: expect.any(Number) },
      { name: "remote", kind: "boolean", required: true },
      { name: "period", kind: "enum", required: false, options: ["year", "month"] },
      { name: "note", kind: "string", required: false },
      { name: "markers", kind: "json", required: false },
    ]);
  });

  it("starts from required props with defaults or placeholders", () => {
    expect(starterProps(schema)).toEqual({ roleTitle: "Example role title", currency: "EUR", min: 1000, remote: false });
  });

  it("streams props like a model: one at a time, strings word by word, arrays item by item", () => {
    expect([...partials({ q: "How was it?", tags: ["a", "b"], n: 3 })]).toEqual([
      { q: "How " },
      { q: "How was " },
      { q: "How was it?" },
      { q: "How was it?", tags: ["a"] },
      { q: "How was it?", tags: ["a", "b"] },
      { q: "How was it?", tags: ["a", "b"], n: 3 },
    ]);
  });
});
