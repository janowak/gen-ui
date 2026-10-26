import { randomUUID } from "node:crypto";
import {
  ChartSpec,
  COMPONENT_CONTRACT,
  DEFAULT_ENVIRONMENT,
  FORM_META_KEY,
  FormSpec,
  PREVIEW_META_KEY,
  RecipePrefill,
  recipeForm,
  type SubmitResult,
  THEME_META_KEY,
  VIEW_CONTENT_KEY,
  VIEW_ID_META_KEY,
  type Catalog,
  type CatalogComponent,
  type Recipe,
  type Theme,
} from "@genui/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ViewBundle, ViewName } from "./views.js";

/** An environment's catalog plus every bundle it references. */
export interface Snapshot {
  catalog: Catalog;
  bundles: Record<string, string>;
}

/** Where custom components, recipes and the theme come from: the registry's store, or files on disk. */
export interface CatalogSource {
  snapshot(environment: string): Promise<Snapshot | undefined>;
  /**
   * Any component bundle by content hash, including versions the snapshot no longer serves, so
   * old messages a host renders again still load. Without it, only the current versions resolve.
   */
  bundle?(hash: string): Promise<string | undefined>;
}

/** What `mountGenUI` registered. `remove()` takes it all off the server, which tells connected clients the lists changed. */
export interface Mounted {
  remove(): void;
}

export interface GenUIOptions {
  /** Workspace theme, or a function returning the current one. Overrides the catalog theme. */
  theme?: Theme | (() => Theme | undefined | Promise<Theme | undefined>);
  /** The built-in form and chart views (`builtInViews(assets)`). */
  views: Record<ViewName, ViewBundle>;
  /** Custom components, recipes and the theme. */
  registry?: CatalogSource;
  /**
   * Environment this server serves. Default prod. Elsewhere, tool and prompt names end in
   * `_<environment>` (`render_form_staging`), so an environment's connector can sit next to prod's.
   */
  environment?: string;
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
   * forms submit to the app-only genui_validate tool, which calls this with the form's render id
   * (one per rendered form, so a repeated submit can be recognised). The end-user MCP posts the
   * values to the recipe's webhook.
   */
  validate?: (recipe: Recipe, values: Record<string, unknown>, viewId: string | undefined) => Promise<SubmitResult>;
}

/** App-only tool that recipe forms with `validate` submit to. */
const VALIDATE_TOOL = "genui_validate";
/** Fixed submit param naming the recipe; the field values are merged next to it. */
const RECIPE_PARAM = "genui_recipe";
/** Submit param the form fills with its render id (`idempotencyParam`). */
const VIEW_PARAM = "genui_view";

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

type Registrar = Pick<McpServer, "registerTool" | "registerResource" | "registerPrompt">;
type Registration = (...args: unknown[]) => Mounted;

/** The server's register* methods, keeping every handle they return. */
function tracked(server: McpServer, handles: Mounted[]): Registrar {
  const keep = (register: Function): Registration => (...args) => {
    const handle = (register as Registration).apply(server, args);
    handles.push(handle);
    return handle;
  };
  return {
    registerTool: keep(server.registerTool) as McpServer["registerTool"],
    registerResource: keep(server.registerResource) as McpServer["registerResource"],
    registerPrompt: keep(server.registerPrompt) as McpServer["registerPrompt"],
  };
}

/** Registers `render_form`, `render_chart` and registry components (tools + `ui://` resources) on an MCP server. */
export async function mountGenUI(target: McpServer, options: GenUIOptions): Promise<Mounted> {
  const handles: Mounted[] = [];
  const server = tracked(target, handles);
  const views = options.views;
  const environment = options.environment ?? DEFAULT_ENVIRONMENT;
  const dataTools = options.dataTools ?? true;
  const registry = options.registry;
  // Previews live on the registry's own MCP and keep their preview_* names.
  const suffix = options.preview || environment === DEFAULT_ENVIRONMENT ? "" : `_${environment}`;
  const label = suffix ? ` (${environment})` : "";
  const formTool = options.preview ? "preview_form" : `render_form${suffix}`;
  const chartTool = options.preview ? "preview_chart" : `render_chart${suffix}`;
  const recipeTool = options.preview ? "preview_recipe" : `use_recipe${suffix}`;
  const validateTool = `${VALIDATE_TOOL}${suffix}`;

  // Read once: the registry builds a server per request, so this is what the request should see.
  const snapshot = await registry?.snapshot(environment);

  async function theme(): Promise<Theme | undefined> {
    if (options.theme) return typeof options.theme === "function" ? options.theme() : options.theme;
    return snapshot?.catalog.theme ?? undefined;
  }

  /** What every render result carries: a fresh render id (views key their saved state by it), the theme and the preview flag. */
  async function rendered(extra: Record<string, unknown> = {}) {
    const current = await theme();
    const id = randomUUID();
    return {
      structuredContent: { [VIEW_CONTENT_KEY]: { id } },
      _meta: {
        [VIEW_ID_META_KEY]: id,
        ...(options.preview ? { [PREVIEW_META_KEY]: true } : {}),
        ...(current ? { [THEME_META_KEY]: current } : {}),
        ...extra,
      },
    };
  }

  for (const view of Object.values(views)) {
    registerAppResource(server, `genui ${view.name}`, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  // An environment can turn the built-in form and chart tools off; their views stay, since recipes render with the form view.
  const builtIns = options.preview || snapshot?.catalog.builtIns !== false;

  const preview = options.preview
    ? "Preview for workspace admins, rendered with the workspace theme. Only inline data works here; data tools live on the customer's own server. "
    : "";

  if (builtIns) {
    registerAppTool(
      server,
      formTool,
      {
        title: options.preview ? "Preview form" : `Show form${label}`,
        description:
          preview +
          "Show an interactive form to the user inside the chat. Use it to collect structured input instead of asking question by question. " +
          (dataTools
            ? "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect, resource_select, resource_multiselect. " +
              "resource_select / resource_multiselect load options by calling a tool (source.toolName) with source.params (fill the tool's required parameters) " +
              "and send the user's search text in source.searchParam; map results with itemsPath, idPath, labelPath. " +
              "With `submit`, the form calls submit.toolName with the field values (keyed by field name) merged into submit.params; field names must match that tool's parameters. " +
              "If that tool takes an idempotency key (e.g. request_id), set submit.idempotencyParam to its name: the form passes one id per rendered form, so a repeated submit is ignored. " +
              "Without `submit`, the values are sent back to the conversation. Do not call the submit tool yourself."
            : "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect. " +
              "This server has no data tools: give options inline and leave out `submit`. The values are sent back to the conversation, where you can act on them."),
        inputSchema: FormSpec,
        _meta: { ui: { resourceUri: views.form.uri } },
      },
      async (spec) => {
        const uses = dataTools ? [] : toolUses(spec);
        if (uses.length) return noDataTools(uses, formTool);
        const fields = `${spec.fields.length} field${spec.fields.length === 1 ? "" : "s"}`;
        const then = spec.submit
          ? `When the user submits, the form calls ${spec.submit.toolName} and you receive the submitted values and result in context.`
          : "When the user submits, the values arrive as a message.";
        return {
          content: [{ type: "text", text: `Showing form${spec.title ? ` "${spec.title}"` : ""} (${fields}). ${then}` }],
          ...(await rendered()),
        };
      },
    );

    registerAppTool(
      server,
      chartTool,
      {
        title: options.preview ? "Preview chart" : `Show chart${label}`,
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
        if (uses.length) return noDataTools(uses, chartTool);
        const what = "source" in spec.data ? `data from ${spec.data.source.toolName}` : "the provided data";
        return {
          content: [{ type: "text", text: `Showing ${spec.type} chart${spec.title ? ` "${spec.title}"` : ""} with ${what}.` }],
          ...(await rendered()),
        };
      },
    );
  }

  // Registry components: render_<name>, each backed by its own content-hashed ui:// resource.
  function mountComponent(component: CatalogComponent, html: string) {
    const { manifest, hash } = component;
    const uri = `ui://genui/c/${manifest.name}/${hash}`;
    registerAppResource(server, `genui ${manifest.name}`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }));
    registerAppTool(
      server,
      `render_${manifest.name}${suffix}`,
      {
        title: `${manifest.title ?? manifest.name}${label}`,
        description: manifest.description,
        inputSchema: fromJsonSchema(manifest.props as Parameters<typeof fromJsonSchema>[0]),
        _meta: { ui: { resourceUri: uri } },
      },
      async () => ({
        content: [{ type: "text" as const, text: `Showing ${manifest.title ?? manifest.name}.` }],
        ...(await rendered()),
      }),
    );
  }

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

  // Earlier versions of components, for old messages the host renders again. Bundles are immutable and kept.
  const lookup = registry?.bundle?.bind(registry);
  if (lookup) {
    server.registerResource(
      "genui component version",
      new ResourceTemplate("ui://genui/c/{name}/{hash}", { list: undefined }),
      { mimeType: RESOURCE_MIME_TYPE },
      async (uri, { hash }) => {
        const html = await lookup(String(hash));
        if (html === undefined) throw new ResourceNotFoundError(uri.href);
        return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] };
      },
    );
  }

  // Workflow prompts: slash commands that start one of the workspace's workflows.
  if (!options.preview) {
    for (const workflow of snapshot?.catalog.prompts ?? []) {
      server.registerPrompt(
        `${workflow.name}${suffix}`,
        {
          title: `${workflow.title ?? workflow.name}${label}`,
          description: workflow.description,
          argsSchema: z.object({ details: z.string().optional().describe("Anything the workflow should know, in plain words.") }),
        },
        ({ details }) => ({
          messages: [{ role: "user", content: { type: "text", text: details ? `${workflow.prompt}\n\nDetails: ${details}` : workflow.prompt } }],
        }),
      );
    }
  }

  // Recipes: one use_recipe tool (the server builds the form; the model picks and pre-fills)
  // plus one prompt per recipe, which hosts show as a slash command.
  const recipes = options.recipes ?? snapshot?.catalog.recipes ?? [];
  if (recipes.length) {
    const names = recipes.map((r) => r.name) as [string, ...string[]];
    const list = recipes.map((r) => `- ${r.name}: ${r.when}${r.notes ? ` ${r.notes}` : ""}`).join("\n");
    registerAppTool(
      server,
      recipeTool,
      {
        title: options.preview ? "Preview recipe" : `Use recipe${label}`,
        description:
          preview +
          `Show one of this workspace's ready-made forms. ${builtIns ? `Prefer it over ${formTool} whenever a recipe matches what the user wants. ` : ""}` +
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
          form.submit = { toolName: validateTool, params: { [RECIPE_PARAM]: recipe.name }, idempotencyParam: VIEW_PARAM, label: form.submit?.label };
        } else if (!dataTools) {
          // No submit tool to call on this server: the values come back to the conversation instead.
          delete form.submit;
        }
        return {
          content: [{ type: "text", text: `Showing the "${recipe.title ?? recipe.name}" form. The user fills it in; you receive the result in context.` }],
          ...(await rendered({ [FORM_META_KEY]: form })),
        };
      },
    );

    const validated = options.validate ? recipes.filter((r) => r.validate) : [];
    if (validated.length) {
      server.registerTool(
        validateTool,
        {
          title: "Check form values",
          description: "Checks a recipe form's values before they reach the model. Called by the form, never by the model.",
          inputSchema: z.looseObject({ [RECIPE_PARAM]: z.string(), [VIEW_PARAM]: z.string().optional() }),
          _meta: { ui: { visibility: ["app"] } },
        },
        async ({ [RECIPE_PARAM]: name, [VIEW_PARAM]: viewId, ...values }) => {
          const recipe = validated.find((r) => r.name === name);
          const result: SubmitResult = recipe ? await options.validate!(recipe, values, viewId) : { ok: false, formError: `Unknown recipe "${name}".` };
          const text = result.ok ? (result.message ?? "Submitted.") : (result.formError ?? "Some answers need fixing.");
          return { content: [{ type: "text", text }], structuredContent: result };
        },
      );
    }

    if (!options.preview) {
      for (const recipe of recipes) {
        server.registerPrompt(
          `${recipe.name}${suffix}`,
          {
            title: `${recipe.title ?? recipe.name}${label}`,
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

  return { remove: () => handles.splice(0).forEach((handle) => handle.remove()) };
}
