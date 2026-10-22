import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Channel, Theme } from "@genui/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RegistryError, type Membership, type Store } from "./store.js";

const require = createRequire(import.meta.url);

/** Management views shipped with @genui/ui, read and hashed once per process. */
const VIEWS = (() => {
  const load = (name: "manager" | "theme") => {
    const html = readFileSync(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
    return { html, uri: `ui://genui-registry/${name}/${hash}` };
  };
  return { manager: load("manager"), theme: load("theme") };
})();

const text = (value: string) => ({ type: "text" as const, text: value });

function ok(message: string, structuredContent: Record<string, unknown>) {
  return { content: [text(message)], structuredContent };
}

function failed(error: unknown) {
  const message = error instanceof RegistryError || error instanceof z.ZodError ? error.message : "Unexpected error";
  return { isError: true, content: [text(message)] };
}

/**
 * The registry's own MCP server, built per request for the signed-in person.
 * Members can browse and preview; admins also get the app-only tools that change
 * what users see (promote, rollback, save theme). Those are never callable by the model:
 * they run only when a person clicks a button in the management views.
 */
export function createRegistryMcp(store: Store, member: Membership): McpServer {
  const server = new McpServer({ name: "genui-registry", version: "0.1.0" });
  const isAdmin = member.role === "admin";
  const ws = member.workspaceId;

  for (const view of Object.values(VIEWS)) {
    registerAppResource(server, view.uri, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  const componentsState = () => ({ role: member.role, components: store.listComponents(ws) });

  registerAppTool(
    server,
    "manage_components",
    {
      title: "Manage components",
      description:
        "Show the workspace's genui components with their beta and stable versions. Admins can promote beta to stable and roll back from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.manager.uri } },
    },
    async () => {
      const state = componentsState();
      const lines = state.components.map((c) => `- ${c.name}: stable ${c.channels.stable ?? "—"}, beta ${c.channels.beta ?? "—"}`);
      return ok(state.components.length ? `Components:\n${lines.join("\n")}` : "No components published yet.", state);
    },
  );

  registerAppTool(
    server,
    "open_theme_controller",
    {
      title: "Theme controller",
      description: "Open the workspace theme controller: colors and radius used by every genui form, chart and component, with a live preview.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.theme.uri } },
    },
    async () => ok("Showing the theme controller.", { role: member.role, theme: store.getTheme(ws) }),
  );

  // Preview the beta version of each component, rendered with props the model provides.
  for (const component of store.catalog(ws, "beta").components) {
    const html = store.bundle(ws, component.hash);
    if (!html) continue;
    const uri = `ui://genui-registry/preview/${component.name}/${component.hash}`;
    registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }));
    registerAppTool(
      server,
      `preview_${component.name}`,
      {
        title: `Preview ${component.manifest.title ?? component.name} ${component.version} (beta)`,
        description: `Preview the beta version (${component.version}) of the "${component.name}" component with sample props. ${component.manifest.description}`,
        inputSchema: fromJsonSchema(component.manifest.props as Parameters<typeof fromJsonSchema>[0]),
        _meta: { ui: { resourceUri: uri } },
      },
      // No tools are allowed in previews: the component's data tools live on the company's server.
      async () => ok(`Previewing ${component.name}@${component.version}.`, { "genui/allowedTools": [] }),
    );
  }

  if (!isAdmin) return server;

  const appOnly = (resourceUri: string) => ({ ui: { resourceUri, visibility: ["app" as const] } });

  registerAppTool(
    server,
    "component_promote",
    {
      title: "Promote to stable",
      description: "Point stable at the current beta (or a given version).",
      inputSchema: z.object({ name: z.string(), version: z.string().optional() }),
      _meta: appOnly(VIEWS.manager.uri),
    },
    async ({ name, version }) => {
      try {
        const promoted = store.promote(ws, name, version);
        return ok(`${name}: stable → ${promoted}`, componentsState());
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "component_rollback",
    {
      title: "Roll back",
      description: "Move a channel back to its previous version.",
      inputSchema: z.object({ name: z.string(), channel: Channel.default("stable") }),
      _meta: appOnly(VIEWS.manager.uri),
    },
    async ({ name, channel }) => {
      try {
        const version = store.rollback(ws, name, channel);
        return ok(`${name}: ${channel} → ${version}`, componentsState());
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "theme_save",
    {
      title: "Save theme",
      description: "Publish the workspace theme. Servers pick it up on their next registry refresh.",
      inputSchema: z.object({ theme: Theme.nullable() }),
      _meta: appOnly(VIEWS.theme.uri),
    },
    async ({ theme }) => {
      store.setTheme(ws, theme);
      return ok(theme ? "Theme saved." : "Theme cleared.", { role: member.role, theme });
    },
  );

  return server;
}
