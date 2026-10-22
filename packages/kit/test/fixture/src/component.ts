import { defineComponent, z } from "../../../src/index.js";

export default defineComponent({
  name: "fixture_badge",
  version: "2.1.0",
  title: "Badge",
  description: "Show a badge.",
  props: z.object({
    label: z.string().describe("Badge text."),
    tone: z.enum(["info", "warn"]).optional(),
  }),
  tools: ["lookup"],
});
