import { z } from "zod";

export const WorkflowName = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase letters, digits and _; also the slash command name");

/** Something the user gives when starting the workflow; hosts show it as the slash command's argument. */
export const WorkflowParam = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "lowercase letters, digits and _"),
  description: z.string().min(1).max(200).describe('Shown as the argument hint, e.g. "The order number".'),
  required: z.boolean().default(false),
});
export type WorkflowParam = z.infer<typeof WorkflowParam>;

/**
 * A playbook in the business's own words: when to use it and the steps, naming the tools and
 * components to use. With params it is a slash command (an MCP prompt taking them); without, it is
 * part of the server instructions the model always has.
 */
export const Workflow = z
  .object({
    name: WorkflowName,
    title: z.string().max(80).optional().describe("Shown as the slash command title and the workflow's heading."),
    description: z.string().min(1).max(300).describe('When to use it, e.g. "The user wants to return an order."'),
    instructions: z
      .string()
      .min(1)
      .max(4000)
      .describe("The steps for the model: what to ask, which tools and components (render_form, render_<component>) to use, in order."),
    params: z.array(WorkflowParam).max(10).default([]).describe("With params the workflow is a slash command taking them."),
  })
  .refine((w) => new Set(w.params.map((p) => p.name)).size === w.params.length, {
    message: "param names must be unique",
    path: ["params"],
  });
export type Workflow = z.infer<typeof Workflow>;

/** A workflow with params is started by the user as a slash command; one without is always-on guidance. */
export const isCommand = (workflow: Pick<Workflow, "params">) => workflow.params.length > 0;

/** The environment's own instructions: the overview of what its MCP helps with. */
export const MAX_ENVIRONMENT_INSTRUCTIONS = 4000;

/** Hosts put server instructions in the model's context on every turn: the overview plus the workflows without params. */
export const MAX_INSTRUCTIONS = 8000;

const heading = (w: Pick<Workflow, "name" | "title">) => (w.title ? `${w.title} (${w.name})` : w.name);

/**
 * The MCP server instructions hosts get: the environment's instructions, then every workflow by name
 * and description, with the full steps of those without params. Undefined when there is nothing to say.
 */
export function serverInstructions(instructions: string | null | undefined, workflows: Workflow[]): string | undefined {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(instructions.trim());
  if (workflows.length) {
    const lines = ["## Workflows"];
    const commands = workflows.filter(isCommand);
    if (commands.length) {
      lines.push("", "The user starts these as slash commands:");
      for (const w of commands) lines.push(`- /${w.name}: ${w.description}`);
    }
    for (const w of workflows.filter((w) => !isCommand(w)))
      lines.push("", `### ${heading(w)}`, `When: ${w.description}`, w.instructions.trim());
    parts.push(lines.join("\n"));
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** The message a command workflow sends: its steps, then the values the user gave. */
export function workflowMessage(workflow: Workflow, args: Record<string, string | undefined>): string {
  const given = workflow.params.filter((p) => args[p.name]?.trim()).map((p) => `${p.name}: ${args[p.name]!.trim()}`);
  return given.length ? `${workflow.instructions.trim()}\n\n${given.join("\n")}` : workflow.instructions.trim();
}
