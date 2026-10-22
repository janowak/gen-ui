import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Channel, PREVIEW_META_KEY, Recipe, Theme, THEME_META_KEY, VIEW_ID_META_KEY } from "@genui/format";
import { mountGenUI } from "@genui/sdk";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RegistryError, type Membership, type Store } from "./store.js";

const require = createRequire(import.meta.url);

/** Management views shipped with @genui/ui, read and hashed once per process. */
const VIEWS = (() => {
  const load = (name: "manager" | "theme" | "recipes") => {
    const html = readFileSync(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
    return { html, uri: `ui://genui-registry/${name}/${hash}` };
  };
  return { manager: load("manager"), theme: load("theme"), recipes: load("recipes") };
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
export async function createRegistryMcp(store: Store, member: Membership): Promise<McpServer> {
  const server = new McpServer({ name: "genui-registry", version: "0.1.0" });
  const isAdmin = member.role === "admin";
  const ws = member.workspaceId;

  // Built-in forms and charts as previews (preview_form / preview_chart) in the workspace theme.
  // No data tools here: those live on the customer's server, so only inline data works.
  await mountGenUI(server, { preview: true, theme: store.getTheme(ws) ?? undefined, recipes: store.listRecipes(ws) });

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

  const recipesState = () => ({ mode: "list", role: member.role, recipes: store.listRecipes(ws) });

  registerAppTool(
    server,
    "manage_recipes",
    {
      title: "Recipes",
      description:
        "Show the workspace's recipes: ready-made forms the AI uses for matching requests, each also available as a slash command. Admins can delete them from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.recipes.uri } },
    },
    async () => {
      const state = recipesState();
      const lines = state.recipes.map((r) => `- /${r.name}: ${r.when}`);
      return ok(state.recipes.length ? `Recipes:\n${lines.join("\n")}` : "No recipes yet.", state);
    },
  );

  registerAppTool(
    server,
    "draft_recipe",
    {
      title: "Draft recipe",
      description:
        "Draft a recipe for review: a named form (fields, validation, submit tool) plus `when` (which requests it handles) and `notes` for the AI. " +
        "Nothing is saved: an admin reviews the draft and clicks Save. Use the customer server's tool names for tool-backed selects and submit. " +
        "Use preview_form first if you want to show how the form looks.",
      inputSchema: Recipe,
      _meta: { ui: { resourceUri: VIEWS.recipes.uri } },
    },
    async (recipe) =>
      ok(`Drafted /${recipe.name} for review. ${isAdmin ? "Click Save recipe to make it live." : "An admin must save it."}`, {
        mode: "draft",
        role: member.role,
        recipe,
        replaces: Boolean(store.getRecipe(ws, recipe.name)),
      }),
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
      // Previews call no tools: the component's data tools live on the company's server.
      async () => {
        const theme = store.getTheme(ws);
        return {
          content: [text(`Previewing ${component.name}@${component.version}.`)],
          _meta: { [PREVIEW_META_KEY]: true, [VIEW_ID_META_KEY]: randomUUID(), ...(theme ? { [THEME_META_KEY]: theme } : {}) },
        };
      },
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
    "recipe_save",
    {
      title: "Save recipe",
      description: "Make a drafted recipe live. Servers pick it up on their next registry refresh.",
      inputSchema: z.object({ recipe: Recipe }),
      _meta: appOnly(VIEWS.recipes.uri),
    },
    async ({ recipe }) => {
      const replaced = store.saveRecipe(ws, recipe);
      return ok(`${replaced ? "Updated" : "Saved"} /${recipe.name}. It reaches your servers within a minute.`, {
        mode: "draft",
        role: member.role,
        recipe,
        replaces: false,
        saved: true,
      });
    },
  );

  registerAppTool(
    server,
    "recipe_delete",
    {
      title: "Delete recipe",
      description: "Delete a recipe and its slash command.",
      inputSchema: z.object({ name: z.string() }),
      _meta: appOnly(VIEWS.recipes.uri),
    },
    async ({ name }) => {
      try {
        store.deleteRecipe(ws, name);
        return ok(`Deleted /${name}.`, recipesState());
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
