import { defineComponent, z } from "@app-mcp/kit";

export const HEAT = ["gentle", "medium", "savage"] as const;

export const roastProps = z.object({
  username: z.string().describe("GitHub login, as the profile data spells it."),
  name: z.string().optional().describe("Display name from the profile, if any."),
  avatar_url: z.url().optional().describe("avatar_url from the GitHub profile."),
  heat: z
    .enum(HEAT)
    .default("medium")
    .describe('How hard this roast goes: "gentle", "medium" (default) or "savage". Match the burns to it.'),
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Roast score, 0 to 100: how roastable the profile is. Higher = more material. Shown as a coffee roast level."),
  headline: z.string().max(120).describe('One-line verdict on top of the card, e.g. "Ships forks, not features."'),
  burns: z
    .array(
      z.object({
        stat: z
          .string()
          .max(40)
          .describe('The real stat the burn is about, short, e.g. "38 of 52 repos are forks" or "61% of pushes after midnight".'),
        line: z.string().max(220).describe("The joke about that stat. One or two sentences."),
      }),
    )
    .min(3)
    .max(5)
    .describe("3 to 5 burns, each tied to a specific real stat from the profile data."),
  compliment: z.string().max(220).describe("One backhanded compliment to close with."),
  stats: z
    .object({
      repos: z.number().int().optional(),
      stars: z.number().int().optional(),
      followers: z.number().int().optional(),
      top_language: z.string().optional(),
      since: z.number().int().optional().describe("Year the account was created."),
    })
    .optional()
    .describe("Headline numbers from the profile data, shown along the bottom of the card."),
});

export default defineComponent({
  name: "roast_my_github",
  title: "Roast my GitHub",
  description:
    "A roast card for a GitHub profile: avatar, a roast score, 3 to 5 burns each tied to a real stat, and a backhanded compliment, with buttons to roast harder, be nicer, or share it. First get the profile's real data (github_roast_stats if you have it, else GitHub's public API with your web fetch tool) and write the roast from that data only; never make up numbers. Funny, not cruel: roast the code habits and stats, never appearance, identity, gender, ethnicity, religion, health or anything personal, and no slurs or profanity aimed at the person.",
  props: roastProps,
  tools: ["share_roast"],
  csp: { resourceDomains: ["https://avatars.githubusercontent.com"] },
});
