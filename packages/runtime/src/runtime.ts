import { randomUUID } from "node:crypto";
import {
  ChartSpec,
  COMPONENT_CONTRACT,
  DEFAULT_ENVIRONMENT,
  FormSpec,
  isCommand,
  PREVIEW_META_KEY,
  THEME_META_KEY,
  VIEW_CONTENT_KEY,
  VIEW_ID_META_KEY,
  type Catalog,
  type CatalogComponent,
  type Theme,
  workflowMessage,
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

/** Where custom components, workflows and the theme come from: the registry's store, or files on disk. */
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
  /** Custom components, workflows and the theme. */
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
  /**
   * Whether views can call tools on this server (option sources, chart sources, submit tools).
   * True behind a customer's server (the SDK forwards genui's tools from there, next to their data
   * tools). False for the public end-user MCP, which only renders: specs that use tools are
   * rejected. Default true.
   */
  dataTools?: boolean;
}

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
  const keep =
    (register: Function): Registration =>
    (...args) => {
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

  // An environment can turn the built-in form and chart tools off.
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

  // Workflows with params are slash commands (MCP prompts) taking them. The others are in the server instructions.
  if (!options.preview) {
    for (const workflow of (snapshot?.catalog.workflows ?? []).filter(isCommand)) {
      const args = Object.fromEntries(
        workflow.params.map((p) => [
          p.name,
          p.required ? z.string().describe(p.description) : z.string().optional().describe(p.description),
        ]),
      );
      server.registerPrompt(
        `${workflow.name}${suffix}`,
        { title: `${workflow.title ?? workflow.name}${label}`, description: workflow.description, argsSchema: z.object(args) },
        (values: Record<string, string | undefined>) => ({
          messages: [{ role: "user", content: { type: "text", text: workflowMessage(workflow, values) } }],
        }),
      );
    }
  }

  return { remove: () => handles.splice(0).forEach((handle) => handle.remove()) };
}
