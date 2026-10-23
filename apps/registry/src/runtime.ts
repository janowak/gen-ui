import { randomUUID } from "node:crypto";
import {
  ChartSpec,
  COMPONENT_CONTRACT,
  FORM_META_KEY,
  FormSpec,
  PREVIEW_META_KEY,
  RecipePrefill,
  recipeForm,
  type SubmitResult,
  THEME_META_KEY,
  VIEW_ID_META_KEY,
  type Catalog,
  type CatalogComponent,
  type Channel,
  type Recipe,
  type Theme,
} from "@genui/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadBuiltInViews, type ViewBundle, type ViewName } from "./views.js";

/** A channel's catalog plus every bundle it references. */
export interface Snapshot {
  catalog: Catalog;
  bundles: Record<string, string>;
}

/** Where custom components, recipes and the theme come from: the registry's own store. */
export interface CatalogSource {
  snapshot(channel: Channel): Snapshot | undefined;
}

export interface GenUIOptions {
  /** Workspace theme, or a function returning the current one. Overrides the catalog theme. */
  theme?: Theme | (() => Theme | undefined | Promise<Theme | undefined>);
  /** Override built-in view bundles. Defaults to the bundles in @genui/ui. */
  views?: Record<ViewName, ViewBundle>;
  /** Custom components, recipes and the theme. */
  registry?: CatalogSource;
  /** Channel this server serves, e.g. "beta" for beta testers. Default "stable". */
  channel?: Channel;
  /**
   * Admin previews (the registry's management MCP): tools are named preview_form / preview_chart,
   * so they never collide with a customer server's render_* tools when both connectors are on.
   */
  preview?: boolean;
  /** Recipes to offer through use_recipe and as slash commands (MCP prompts). Defaults to the registry's. */
  recipes?: Recipe[];
  /**
   * Whether views can call tools on this server (option sources, chart sources, submit tools).
   * True behind a customer's server (the SDK forwards genui's tools from there, next to their data
   * tools). False for the public end-user MCP, which only renders: specs that use tools are
   * rejected, and recipe forms send their values back to the conversation. Default true.
   */
  dataTools?: boolean;
  /**
   * Checks a recipe's values before they reach the model, for recipes with `validate` set. Their
   * forms submit to the app-only genui_validate tool, which calls this. The end-user MCP posts the
   * values to the recipe's webhook.
   */
  validate?: (recipe: Recipe, values: Record<string, unknown>) => Promise<SubmitResult>;
}

/** App-only tool that recipe forms with `validate` submit to. */
const VALIDATE_TOOL = "genui_validate";
/** Fixed submit param naming the recipe; the field values are merged next to it. */
const RECIPE_PARAM = "genui_recipe";

/** Components already reported as too new, so per-request servers warn once per process. */
const tooNew = new Set<string>();

/** What a spec makes its view call: tool-backed fields, the submit tool or a chart source. */
function toolUses(spec: FormSpec | ChartSpec): string[] {
  if ("fields" in spec) {
    const fields = spec.fields.flatMap((f) =>
      f.type === "resource_select" || f.type === "resource_multiselect" ? [`field "${f.name}" (${f.source.toolName})`] : [],
    );
    return spec.submit ? [...fields, `submit (${spec.submit.toolName})`] : fields;
  }
  return "source" in spec.data ? [`data.source (${spec.data.source.toolName})`] : [];
}

function noDataTools(uses: string[], tool: string) {
  const text = `This server has no data tools, so ${uses.join(", ")} cannot work. Pass options and data inline, leave out submit, and call ${tool} again.`;
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Registers `render_form`, `render_chart` and registry components (tools + `ui://` resources) on an MCP server. */
export async function mountGenUI(server: McpServer, options: GenUIOptions = {}): Promise<void> {
  const views = options.views ?? (await loadBuiltInViews());
  const channel = options.channel ?? "stable";
  const dataTools = options.dataTools ?? true;
  const registry = options.registry;

  async function theme(): Promise<Theme | undefined> {
    if (options.theme) return typeof options.theme === "function" ? options.theme() : options.theme;
    return registry?.snapshot(channel)?.catalog.theme ?? undefined;
  }

  async function meta() {
    const current = await theme();
    return {
      [VIEW_ID_META_KEY]: randomUUID(),
      ...(options.preview ? { [PREVIEW_META_KEY]: true } : {}),
      ...(current ? { [THEME_META_KEY]: current } : {}),
    };
  }

  for (const view of Object.values(views)) {
    registerAppResource(server, `genui ${view.name}`, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  const preview = options.preview
    ? "Preview for workspace admins, rendered with the workspace theme. Only inline data works here; data tools live on the customer's own server. "
    : "";

  registerAppTool(
    server,
    options.preview ? "preview_form" : "render_form",
    {
      title: options.preview ? "Preview form" : "Show form",
      description:
        preview +
        "Show an interactive form to the user inside the chat. Use it to collect structured input instead of asking question by question. " +
        (dataTools
          ? "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect, resource_select, resource_multiselect. " +
            "resource_select / resource_multiselect load options by calling a tool (source.toolName) with source.params (fill the tool's required parameters) " +
            "and send the user's search text in source.searchParam; map results with itemsPath, idPath, labelPath. " +
            "With `submit`, the form calls submit.toolName with the field values (keyed by field name) merged into submit.params; field names must match that tool's parameters. " +
            "Without `submit`, the values are sent back to the conversation. Do not call the submit tool yourself."
          : "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect. " +
            "This server has no data tools: give options inline and leave out `submit`. The values are sent back to the conversation, where you can act on them."),
      inputSchema: FormSpec,
      _meta: { ui: { resourceUri: views.form.uri } },
    },
    async (spec) => {
      const uses = dataTools ? [] : toolUses(spec);
      if (uses.length) return noDataTools(uses, options.preview ? "preview_form" : "render_form");
      const fields = `${spec.fields.length} field${spec.fields.length === 1 ? "" : "s"}`;
      const then = spec.submit
        ? `When the user submits, the form calls ${spec.submit.toolName} and you receive the submitted values and result in context.`
        : "When the user submits, the values arrive as a message.";
      return {
        content: [{ type: "text", text: `Showing form${spec.title ? ` "${spec.title}"` : ""} (${fields}). ${then}` }],
        _meta: await meta(),
      };
    },
  );

  registerAppTool(
    server,
    options.preview ? "preview_chart" : "render_chart",
    {
      title: options.preview ? "Preview chart" : "Show chart",
      description:
        preview +
        "Show a chart (line, bar, area, pie, donut) inside the chat. " +
        (dataTools
          ? "Three ways to pass data: " +
            "data.rows (rows you already have; map them with `x` and `series`), " +
            "data.categories + data.series (chart-native values for small charts), or " +
            "data.source (the chart calls a tool itself; use for ~200+ rows or live data, optionally with refreshSeconds). "
          : "Two ways to pass data: " +
            "data.rows (rows you already have; map them with `x` and `series`), or " +
            "data.categories + data.series (chart-native values for small charts). This server has no data tools, so data.source is not available. ") +
        "Pie and donut plot the first series.",
      inputSchema: ChartSpec,
      _meta: { ui: { resourceUri: views.chart.uri } },
    },
    async (spec) => {
      const uses = dataTools ? [] : toolUses(spec);
      if (uses.length) return noDataTools(uses, options.preview ? "preview_chart" : "render_chart");
      const what = "source" in spec.data ? `data from ${spec.data.source.toolName}` : "the provided data";
      return {
        content: [{ type: "text", text: `Showing ${spec.type} chart${spec.title ? ` "${spec.title}"` : ""} with ${what}.` }],
        _meta: await meta(),
      };
    },
  );

  // Registry components: render_<name>, each backed by its own content-hashed ui:// resource.
  function mountComponent(component: CatalogComponent, html: string) {
    const { manifest, hash } = component;
    const uri = `ui://genui/c/${manifest.name}/${hash}`;
    registerAppResource(server, `genui ${manifest.name}`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }));
    registerAppTool(
      server,
      `render_${manifest.name}`,
      {
        title: manifest.title ?? manifest.name,
        description: manifest.description,
        inputSchema: fromJsonSchema(manifest.props as Parameters<typeof fromJsonSchema>[0]),
        _meta: { ui: { resourceUri: uri } },
      },
      async () => ({
        content: [{ type: "text" as const, text: `Showing ${manifest.title ?? manifest.name}.` }],
        _meta: await meta(),
      }),
    );
  }

  const snapshot = registry?.snapshot(channel);
  for (const component of snapshot?.catalog.components ?? []) {
    // Built with a newer @genui/kit than this server serves: it would render without data it expects.
    if ((component.manifest.contract ?? 0) > COMPONENT_CONTRACT) {
      if (!tooNew.has(component.hash)) {
        tooNew.add(component.hash);
        console.warn(
          `[genui] skipping ${component.name}@${component.version}: needs component contract ${component.manifest.contract}, this server serves ${COMPONENT_CONTRACT}. Update genui.`,
        );
      }
      continue;
    }
    const html = snapshot!.bundles[component.hash];
    if (html) mountComponent(component, html);
  }

  // Recipes: one use_recipe tool (the server builds the form; the model picks and pre-fills)
  // plus one prompt per recipe, which hosts show as a slash command.
  const recipeTool = options.preview ? "preview_recipe" : "use_recipe";
  const recipes = options.recipes ?? snapshot?.catalog.recipes ?? [];
  if (recipes.length) {
    const names = recipes.map((r) => r.name) as [string, ...string[]];
    const list = recipes.map((r) => `- ${r.name}: ${r.when}${r.notes ? ` ${r.notes}` : ""}`).join("\n");
    registerAppTool(
      server,
      recipeTool,
      {
        title: options.preview ? "Preview recipe" : "Use recipe",
        description:
          preview +
          "Show one of this workspace's ready-made forms. Prefer it over render_form whenever a recipe matches what the user wants. " +
          "Pick the recipe and pre-fill the fields you already know from the conversation; the fields, validation and submit action are fixed. " +
          "Do not call the submit tool yourself.\nRecipes:\n" +
          list,
        inputSchema: z.object({
          recipe: z.enum(names),
          prefill: RecipePrefill.optional().describe("Known values keyed by field name. Selects take an option id; tool-backed selects take { id, label }."),
        }),
        _meta: { ui: { resourceUri: views.form.uri } },
      },
      async ({ recipe: name, prefill }) => {
        const recipe = recipes.find((r) => r.name === name)!;
        const form = recipeForm(recipe, prefill);
        if (options.validate && recipe.validate) {
          // Checked by genui_validate first, then sent to the model like a form without a submit tool.
          form.submit = { toolName: VALIDATE_TOOL, params: { [RECIPE_PARAM]: recipe.name }, label: form.submit?.label };
        } else if (!dataTools) {
          // No submit tool to call on this server: the values come back to the conversation instead.
          delete form.submit;
        }
        return {
          content: [{ type: "text", text: `Showing the "${recipe.title ?? recipe.name}" form. The user fills it in; you receive the result in context.` }],
          _meta: { ...(await meta()), [FORM_META_KEY]: form },
        };
      },
    );

    const validated = options.validate ? recipes.filter((r) => r.validate) : [];
    if (validated.length) {
      server.registerTool(
        VALIDATE_TOOL,
        {
          title: "Check form values",
          description: "Checks a recipe form's values before they reach the model. Called by the form, never by the model.",
          inputSchema: z.looseObject({ [RECIPE_PARAM]: z.string() }),
          _meta: { ui: { visibility: ["app"] } },
        },
        async ({ [RECIPE_PARAM]: name, ...values }) => {
          const recipe = validated.find((r) => r.name === name);
          const result: SubmitResult = recipe ? await options.validate!(recipe, values) : { ok: false, formError: `Unknown recipe "${name}".` };
          const text = result.ok ? (result.message ?? "Submitted.") : (result.formError ?? "Some answers need fixing.");
          return { content: [{ type: "text", text }], structuredContent: result };
        },
      );
    }

    if (!options.preview) {
      for (const recipe of recipes) {
        server.registerPrompt(
          recipe.name,
          {
            title: recipe.title ?? recipe.name,
            description: recipe.when,
            argsSchema: z.object({ details: z.string().optional().describe("Anything to pre-fill, in plain words.") }),
          },
          ({ details }) => ({
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text:
                    `Use the "${recipe.title ?? recipe.name}" recipe: call ${recipeTool} with recipe "${recipe.name}". ` +
                    (details ? `Pre-fill from: ${details}` : "Pre-fill what you already know from this conversation."),
                },
              },
            ],
          }),
        );
      }
    }
  }
}
