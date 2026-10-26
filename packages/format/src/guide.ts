import { z } from "zod";
import { RecipeName } from "./recipe.js";

/**
 * A slash command (MCP prompt) that starts one of the workspace's workflows. Hosts show it next to the
 * recipes' commands; picking it sends `prompt` to the model, plus whatever the user typed after it.
 */
export const WorkflowPrompt = z.object({
  name: RecipeName.describe("Slash command name; can't be a recipe's name."),
  title: z.string().max(80).optional().describe("Shown as the slash command title."),
  description: z.string().min(1).max(300).describe('What the workflow does, e.g. "Return an order and pick a refund."'),
  prompt: z.string().min(1).max(4000).describe("What the model is told when the command runs: the steps, the tools and recipes to use, in order."),
});
export type WorkflowPrompt = z.infer<typeof WorkflowPrompt>;

/** Hosts put server instructions in the model's context on every turn, so they stay short. */
export const MAX_INSTRUCTIONS = 4000;

/**
 * How the model should use an environment's MCP: instructions it reads when the connector is added
 * (which workflows it covers, in what order to use tools and recipes) and workflow slash commands.
 */
export const Guide = z.object({
  instructions: z.string().max(MAX_INSTRUCTIONS).optional().describe("Sent as the MCP server's instructions: what this MCP helps with and how its workflows go."),
  prompts: z.array(WorkflowPrompt).max(30).default([]),
});
export type Guide = z.infer<typeof Guide>;

/** How the workspace's connector presents itself to hosts (MCP serverInfo). The icon is uploaded separately. */
export const Branding = z.object({
  title: z.string().min(1).max(80).optional().describe("Display name, e.g. \"Acme Support\". Default: the workspace name."),
  description: z.string().min(1).max(500).optional().describe("One or two sentences on what the connector does."),
  websiteUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type Branding = z.infer<typeof Branding>;

/** Icon formats MCP hosts render. SVG is served with a CSP that blocks scripts. */
export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type IconType = (typeof ICON_TYPES)[number];
export const MAX_ICON_BYTES = 100_000;
