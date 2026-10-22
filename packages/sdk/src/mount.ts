import { ChartSpec, FormSpec, THEME_META_KEY, type CatalogComponent, type Channel, type Theme } from "@genui/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { checkChart, checkForm, type AllowTools, type Check } from "./allowlist.js";
import type { RegistryClient } from "./registry.js";
import { loadBuiltInViews, type ViewBundle, type ViewName } from "./views.js";

/** Must match ALLOWED_TOOLS_META_KEY in @genui/ui. */
export const ALLOWED_TOOLS_META_KEY = "genui/allowedTools";

export interface GenUIOptions {
  /** Tools views may call. Anything not listed is rejected before the view renders. */
  allowTools?: AllowTools;
  /** Workspace theme, or a function returning the current one. Overrides the registry theme. */
  theme?: Theme | (() => Theme | undefined | Promise<Theme | undefined>);
  /** Override built-in view bundles. Defaults to the bundles in @genui/ui. */
  views?: Record<ViewName, ViewBundle>;
  /** Registry to pull custom components and the theme from. */
  registry?: RegistryClient;
  /** Registry channel this server instance serves, e.g. "beta" for beta testers. Default "stable". */
  channel?: Channel;
  /**
   * Long-lived (stateful) servers: re-sync custom components when the registry changes and notify
   * the client with tools/list_changed. Leave off for per-request servers.
   */
  watch?: boolean;
}

export interface GenUIHandle {
  views: Record<ViewName, ViewBundle>;
  /** Custom components currently registered, as name@version. */
  components(): string[];
  /** Stops watching the registry. */
  close(): void;
}

function describeTools(allow: AllowTools): string {
  const parts: string[] = [];
  if (allow.sources?.length) parts.push(`Allowed option/data source tools: ${allow.sources.join(", ")}.`);
  if (allow.submit?.length) parts.push(`Allowed submit tools: ${allow.submit.join(", ")}.`);
  return parts.length ? ` ${parts.join(" ")}` : " No tool-backed sources or submit tools are enabled.";
}

function rejected(check: Extract<Check, { ok: false }>) {
  return { isError: true, content: [{ type: "text" as const, text: `${check.error} Fix the definition and call the tool again.` }] };
}

/** Registers `render_form`, `render_chart` and registry components (tools + `ui://` resources) on an MCP server. */
export async function mountGenUI(server: McpServer, options: GenUIOptions = {}): Promise<GenUIHandle> {
  const views = options.views ?? (await loadBuiltInViews());
  const allow = options.allowTools ?? {};
  const channel = options.channel ?? "stable";
  const registry = options.registry;
  if (registry) await registry.ready();

  async function theme(): Promise<Theme | undefined> {
    if (options.theme) return typeof options.theme === "function" ? options.theme() : options.theme;
    return registry?.snapshot(channel)?.catalog.theme ?? undefined;
  }

  async function meta(tools: string[]) {
    const current = await theme();
    return { [ALLOWED_TOOLS_META_KEY]: tools, ...(current ? { [THEME_META_KEY]: current } : {}) };
  }

  for (const view of Object.values(views)) {
    registerAppResource(server, `genui ${view.name}`, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  registerAppTool(
    server,
    "render_form",
    {
      title: "Show form",
      description:
        "Show an interactive form to the user inside the chat. Use it to collect structured input instead of asking question by question. " +
        "Field types: text, textarea, email, number, date, checkbox, switch, radio, select, multiselect, resource_select, resource_multiselect. " +
        "resource_select / resource_multiselect load options by calling a tool (source.toolName) with source.params (fill the tool's required parameters) " +
        "and send the user's search text in source.searchParam; map results with itemsPath, idPath, labelPath. " +
        "With `submit`, the form calls submit.toolName with the field values (keyed by field name) merged into submit.params; field names must match that tool's parameters. " +
        "Without `submit`, the values are sent back to the conversation. Do not call the submit tool yourself." +
        describeTools(allow),
      inputSchema: FormSpec,
      _meta: { ui: { resourceUri: views.form.uri } },
    },
    async (spec) => {
      const check = checkForm(spec, allow);
      if (!check.ok) return rejected(check);
      const fields = `${spec.fields.length} field${spec.fields.length === 1 ? "" : "s"}`;
      const then = spec.submit
        ? `When the user submits, the form calls ${spec.submit.toolName} and you receive the submitted values and result in context.`
        : "When the user submits, the values arrive as a message.";
      return {
        content: [{ type: "text", text: `Showing form${spec.title ? ` "${spec.title}"` : ""} (${fields}). ${then}` }],
        _meta: await meta(check.tools),
      };
    },
  );

  registerAppTool(
    server,
    "render_chart",
    {
      title: "Show chart",
      description:
        "Show a chart (line, bar, area, pie, donut) inside the chat. Three ways to pass data: " +
        "data.rows (rows you already have; map them with `x` and `series`), " +
        "data.categories + data.series (chart-native values for small charts), or " +
        "data.source (the chart calls a tool itself; use for ~200+ rows or live data, optionally with refreshSeconds). " +
        "Pie and donut plot the first series." +
        describeTools(allow),
      inputSchema: ChartSpec,
      _meta: { ui: { resourceUri: views.chart.uri } },
    },
    async (spec) => {
      const check = checkChart(spec, allow);
      if (!check.ok) return rejected(check);
      const what = "source" in spec.data ? `data from ${spec.data.source.toolName}` : "the provided data";
      return {
        content: [{ type: "text", text: `Showing ${spec.type} chart${spec.title ? ` "${spec.title}"` : ""} with ${what}.` }],
        _meta: await meta(check.tools),
      };
    },
  );

  // Registry components: render_<name>, each backed by its own content-hashed ui:// resource.
  const allowed = new Set([...(allow.sources ?? []), ...(allow.submit ?? [])]);
  const mounted = new Map<string, { hash: string; version: string; remove: () => void }>();

  function mountComponent(component: CatalogComponent, html: string) {
    const { manifest, hash } = component;
    const uri = `ui://genui/c/${manifest.name}/${hash}`;
    const tools = manifest.tools.filter((t) => allowed.has(t));
    const blocked = manifest.tools.filter((t) => !allowed.has(t));
    if (blocked.length) console.warn(`[genui] ${manifest.name}@${manifest.version} wants tools not in allowTools: ${blocked.join(", ")}`);

    const resource = registerAppResource(server, `genui ${manifest.name}`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }));
    const tool = registerAppTool(
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
        _meta: await meta(tools),
      }),
    );
    mounted.set(manifest.name, {
      hash,
      version: manifest.version,
      remove: () => {
        tool.remove();
        resource.remove();
      },
    });
  }

  /** Brings registered components in line with the channel's snapshot. Returns true if anything changed. */
  function sync(): boolean {
    const snapshot = registry?.snapshot(channel);
    if (!snapshot) return false;
    const wanted = new Map(snapshot.catalog.components.map((c) => [c.manifest.name, c]));
    let changed = false;
    for (const [name, entry] of mounted) {
      if (wanted.get(name)?.hash !== entry.hash) {
        entry.remove();
        mounted.delete(name);
        changed = true;
      }
    }
    for (const [name, component] of wanted) {
      if (mounted.has(name)) continue;
      const html = snapshot.bundles[component.hash];
      if (html) {
        mountComponent(component, html);
        changed = true;
      }
    }
    return changed;
  }

  sync();
  const unsubscribe =
    registry && options.watch
      ? registry.onChange((changedChannel) => {
          if (changedChannel === channel && sync()) {
            server.sendToolListChanged();
            server.sendResourceListChanged();
          }
        })
      : () => {};

  return {
    views,
    components: () => [...mounted.entries()].map(([name, e]) => `${name}@${e.version}`),
    close: unsubscribe,
  };
}
