import { defineComponent, z } from "@app-mcp/kit";

const text = (max: number) => z.string().trim().min(1).max(max);

export const WrappedData = z.object({
  year: z.number().int().min(2000).max(2100).describe("The year being wrapped, e.g. 2026."),
  name: text(40).optional().describe("The user's first name or handle, if you know it. Leave it out otherwise."),
  stats: z
    .object({
      conversations: z.number().int().min(0).optional().describe("Conversations you know of."),
      messages: z.number().int().min(0).optional().describe("Messages the user sent, as best you can tell."),
      hours: z.number().min(0).optional().describe("Hours spent together, roughly."),
    })
    .optional()
    .describe("Headline numbers. Only ones you can reasonably estimate; leave the object out if you can't."),
  topics: z
    .array(
      z.object({
        name: text(40).describe('A topic in a few words, e.g. "TypeScript generics".'),
        note: text(80).optional().describe('One short, specific line about it, e.g. "mostly at 1am".'),
      }),
    )
    .min(1)
    .max(5)
    .describe("Top topics, most talked about first."),
  phrase: z
    .object({
      text: text(60).describe('Something the user kept saying, in their words, e.g. "just one more fix".'),
      count: z.number().int().min(2).describe("How many times, as best you can tell."),
    })
    .describe("The user's recurring phrase."),
  themes: z
    .array(
      z.object({
        name: text(28).describe('A theme, e.g. "Debugging", "Trip planning".'),
        weight: z.number().min(1).max(100).describe("How much of the user's time it took, 1–100, relative to the others."),
      }),
    )
    .min(2)
    .max(6)
    .describe("Busiest themes: broader than topics, for a bar chart."),
  personality: z
    .object({
      type: text(36).describe('A playful AI personality type, e.g. "The Midnight Refactorer".'),
      description: text(180).describe("Two sentences on why, kind and a little teasing, specific to this user."),
      traits: z.array(text(24)).max(3).optional().describe("Up to three short traits."),
    })
    .describe("The user's AI personality type."),
  summary: text(140).describe("The closing line: the year in one sentence, warm and specific."),
});
export type WrappedData = z.infer<typeof WrappedData>;

export default defineComponent({
  name: "wrapped",
  title: "AI Wrapped",
  description:
    "Show the user their AI Wrapped: an animated, Spotify Wrapped-style set of cards about how they used AI this year, which they can share with a public link. Use it when the user asks for their Wrapped, a year in review or a recap of what you've done together. Fill it from this conversation and what you remember about the user; keep it specific, funny and kind, and never include secrets, credentials or anything private about other people, since the user may share it publicly.",
  props: WrappedData,
});
