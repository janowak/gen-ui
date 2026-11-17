import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createGithubClient, GithubError } from "./github.js";

/** Tools behind the roast_my_github component: public GitHub stats for the model, and share links for the view. */
export function registerRoastTools(
  server: McpServer,
  github = createGithubClient({ token: process.env.GITHUB_TOKEN }),
  siteUrl = process.env.APP_MCP_SITE_URL ?? "https://app-mcp.com",
): void {
  server.registerTool(
    "github_roast_stats",
    {
      description:
        "Public GitHub stats for roasting a profile with render_roast_my_github: profile, repos (forks, tutorial-looking repos, missing READMEs and descriptions, abandoned repos), languages, stars and push times. Hours are UTC.",
      inputSchema: z.object({ username: z.string().describe("GitHub username, with or without @") }),
    },
    async ({ username }) => {
      try {
        const stats = await github.roastStats(username);
        return { content: [{ type: "text" as const, text: JSON.stringify(stats) }], structuredContent: stats };
      } catch (error) {
        const message = error instanceof GithubError ? error.message : "Couldn't load the GitHub profile.";
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );

  server.registerTool(
    "share_roast",
    {
      description: "Makes a public link to a roast card. Called by the roast_my_github view's Share button.",
      inputSchema: z.object({
        card: z
          .string()
          .max(8000)
          .regex(/^[\w-]+$/)
          .describe("The card, encoded by the view."),
        username: z.string().optional(),
      }),
    },
    async ({ card, username }) => {
      const url = `${siteUrl.replace(/\/$/, "")}/roast#${card}`;
      console.log(`[demo] roast shared${username ? ` for @${username}` : ""}`);
      const result = { ok: true, url };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    },
  );
}
