import { defineComponent, z } from "@genui/kit";

export default defineComponent({
  name: "rating",
  version: "1.2.0",
  title: "Star rating",
  description:
    "Ask the user to rate something from 1 to 5 stars (or up to `max`) inside the chat. Use it for quick satisfaction or quality feedback.",
  props: z.object({
    question: z.string().describe('What the user rates, e.g. "How was your delivery?"'),
    subject: z.string().optional().describe("Id of the rated thing, passed to save_rating."),
    max: z.number().int().min(3).max(10).optional().describe("Number of stars (default 5)."),
  }),
  tools: ["save_rating"],
});
