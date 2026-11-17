import type { WrappedData } from "./component";

/** Realistic props, for tests and for trying the view in `app-mcp dev`. */
export const sample: WrappedData = {
  year: 2026,
  name: "Kuba",
  stats: { conversations: 412, messages: 6318, hours: 287 },
  topics: [
    { name: "MCP Apps", note: "You read the spec more than most people who wrote it" },
    { name: "Cloudflare Workers", note: "D1, R2 and one very long night with wrangler" },
    { name: "Pricing pages" },
    { name: "Preact vs React" },
    { name: "Landing page copy" },
  ],
  phrase: { text: "just one more fix", count: 41 },
  themes: [
    { name: "Debugging", weight: 92 },
    { name: "Shipping", weight: 74 },
    { name: "Naming things", weight: 51 },
    { name: "Second-guessing", weight: 33 },
    { name: "Trip planning", weight: 12 },
  ],
  personality: {
    type: "The Midnight Refactorer",
    description:
      "You start with a tiny change and end with a cleaner codebase, usually after 1am. You never ask for permission, only for a second opinion.",
    traits: ["Ships on Fridays", "Deletes more than adds", "Reads the docs"],
  },
  summary: "A year of shipping tiny things that added up to something big, one more fix at a time.",
};
