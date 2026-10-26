import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PREVIEW_META_KEY, Recipe, Theme, THEME_META_KEY, VIEW_CONTENT_KEY, VIEW_ID_META_KEY } from "@genui/format";
import { mountGenUI } from "./runtime.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { endUserPath } from "./api.js";
import { RegistryError, type Membership, type Store } from "./store.js";

const require = createRequire(import.meta.url);

/** Management views shipped with @genui/ui, read and hashed once per process. */
const VIEWS = (() => {
  const load = (name: "manager" | "theme" | "recipes" | "workspace") => {
    const html = readFileSync(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
    return { html, uri: `ui://genui-registry/${name}/${hash}` };
  };
  return { manager: load("manager"), theme: load("theme"), recipes: load("recipes"), workspace: load("workspace") };
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
 * Members can browse, preview and pick the environment they look at; admins also get the
 * app-only tools that change what users see (save theme, save or delete recipes). Those are
 * never callable by the model: they run only when a person clicks a button in the management views.
 * `baseURL` is the registry's public URL, for the end-user MCP addresses the workspace view shows.
 * `toolsChanged` tells open clients to re-list, after a switch changes the preview tools.
 */
export async function createRegistryMcp(store: Store, member: Membership, baseURL: string, toolsChanged: () => void = () => {}): Promise<McpServer> {
  const server = new McpServer({ name: "genui-registry", version: "0.1.0" });
  const isAdmin = member.role === "admin";
  const ws = member.workspaceId;
  // Previews, theme and recipes show the member's active environment.
  const env = member.environment;

  // Built-in forms and charts as previews (preview_form / preview_chart) in the environment's theme.
  // No data tools here: those live on the customer's server, so only inline data works.
  await mountGenUI(server, { preview: true, theme: store.getTheme(ws, env) ?? undefined, recipes: store.listRecipes(ws, env) });

  for (const view of Object.values(VIEWS)) {
    registerAppResource(server, view.uri, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  const componentsState = (environment = env) => ({
    role: member.role,
    environment,
    environments: store.listEnvironments(ws),
    components: store.listComponents(ws),
  });

  registerAppTool(
    server,
    "manage_components",
    {
      title: "Manage components",
      description:
        "Show the workspace's genui components and the version each environment (prod, staging, …) serves. CI publishes versions to environments; nothing moves between them here.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.manager.uri } },
    },
    async () => {
      const state = componentsState();
      const lines = state.components.map(
        (c) => `- ${c.name}: ${state.environments.map((e) => `${e} ${c.environments[e] ?? "—"}`).join(", ")}`,
      );
      const active = `Previews, theme and recipes show ${env}.`;
      return ok(state.components.length ? `Components:\n${lines.join("\n")}\n${active}` : `No components published yet. ${active}`, state);
    },
  );

  registerAppTool(
    server,
    "use_environment",
    {
      title: "Use environment",
      description:
        "Switch the environment your previews, theme and recipes show here (default prod). It changes only what you see in this connector; " +
        "end users get whatever each environment's own connector serves.",
      inputSchema: z.object({ name: z.string().describe("Environment name, e.g. staging.") }),
      _meta: { ui: { resourceUri: VIEWS.manager.uri } },
    },
    async ({ name }) => {
      try {
        store.setActiveEnvironment(ws, member.userId, name);
        if (name !== env) toolsChanged();
        return ok(
          `Now showing ${name}: previews, theme and recipes follow it. If the preview tools still show the old versions, start a new chat.`,
          componentsState(name),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "open_theme_controller",
    {
      title: "Theme controller",
      description: `Open the theme controller for ${env}: colors and radius used by every genui form, chart and component there, with a live preview.`,
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.theme.uri } },
    },
    async () => ok(`Showing the ${env} theme controller.`, { role: member.role, environment: env, theme: store.getTheme(ws, env) }),
  );

  const recipesState = (environment = env) => ({ mode: "list", role: member.role, environment, recipes: store.listRecipes(ws, environment) });

  registerAppTool(
    server,
    "manage_recipes",
    {
      title: "Recipes",
      description:
        `Show the recipes in ${env}: ready-made forms the AI uses for matching requests, each also available as a slash command. ` +
        "Admins can delete them from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.recipes.uri } },
    },
    async () => {
      const state = recipesState();
      const lines = state.recipes.map((r) => `- /${r.name}: ${r.when}`);
      return ok(state.recipes.length ? `Recipes in ${env}:\n${lines.join("\n")}` : `No recipes in ${env} yet.`, state);
    },
  );

  registerAppTool(
    server,
    "draft_recipe",
    {
      title: "Draft recipe",
      description:
        `Draft a recipe for review in ${env}: a named form (fields, validation, submit tool) plus \`when\` (which requests it handles) and \`notes\` for the AI. ` +
        "Nothing is saved: an admin reviews the draft and clicks Save. Use the customer server's tool names for tool-backed selects and submit. " +
        "Use preview_form first if you want to show how the form looks.",
      inputSchema: Recipe,
      _meta: { ui: { resourceUri: VIEWS.recipes.uri } },
    },
    async (recipe) =>
      ok(`Drafted /${recipe.name} for ${env}. ${isAdmin ? `Click Save recipe to make it live in ${env}.` : "An admin must save it."}`, {
        mode: "draft",
        role: member.role,
        environment: env,
        recipe,
        replaces: Boolean(store.getRecipe(ws, env, recipe.name)),
      }),
  );

  // Who manages the workspace, how servers connect, and whether its end-user MCP is public.
  // Admins change these only by clicking in the view (app-only tools below); server tokens never reach the model.
  const workspaceState = (extra: Record<string, unknown> = {}) => ({
    role: member.role,
    workspace: store.workspace(ws),
    ...store.listMembers(ws),
    public: store.isHosted(ws),
    connectors: store.listEnvironments(ws).map((environment) => ({ environment, url: `${baseURL}${endUserPath(ws, environment)}` })),
    ...(isAdmin ? { tokens: store.listTokens(ws) } : {}),
    ...extra,
  });

  const Invite = z.object({ email: z.email(), role: z.enum(["member", "admin"]).default("member") });

  registerAppTool(
    server,
    "manage_workspace",
    {
      title: "Workspace",
      description:
        "Show the workspace's members and pending invites, the end-user MCP address of each environment, and whether it's public. " +
        "Admins invite people, create server tokens for @genui/sdk and turn the public MCP on or off from the view. " +
        "Pass `invite` to prefill an invite the admin then sends with a click.",
      inputSchema: z.object({ invite: Invite.optional().describe("Someone to invite, prefilled in the view.") }),
      _meta: { ui: { resourceUri: VIEWS.workspace.uri } },
    },
    async ({ invite }) => {
      const state = workspaceState(invite ? { draftInvite: invite } : {});
      const people = state.members.map((m) => `- ${m.name ?? m.email ?? m.userId} (${m.role})`);
      const pending = state.invites.map((i) => `- ${i.email} (${i.role}, invited)`);
      const access = state.public
        ? "The end-user MCP is public: anyone with its address can use it, and servers with a server token too."
        : "The end-user MCP is private: only servers with a server token can use it.";
      const next = invite ? (isAdmin ? ` Click Invite to send the invite to ${invite.email}.` : " Only admins can invite.") : "";
      return ok(`Members:\n${[...people, ...pending].join("\n")}\n${access}${next}`, state);
    },
  );

  // Preview the version the active environment serves of each component, rendered with props the model provides.
  for (const component of store.catalog(ws, env).components) {
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
        title: `Preview ${component.manifest.title ?? component.name} ${component.version} (${env})`,
        description: `Preview the version ${env} serves (${component.version}) of the "${component.name}" component with sample props. ${component.manifest.description}`,
        inputSchema: fromJsonSchema(component.manifest.props as Parameters<typeof fromJsonSchema>[0]),
        _meta: { ui: { resourceUri: uri } },
      },
      // Previews call no tools: the component's data tools live on the company's server.
      async () => {
        const theme = store.getTheme(ws, env);
        const id = randomUUID();
        return {
          content: [text(`Previewing ${component.name}@${component.version}.`)],
          structuredContent: { [VIEW_CONTENT_KEY]: { id } },
          _meta: { [PREVIEW_META_KEY]: true, [VIEW_ID_META_KEY]: id, ...(theme ? { [THEME_META_KEY]: theme } : {}) },
        };
      },
    );
  }

  if (!isAdmin) return server;

  const appOnly = (resourceUri: string) => ({ ui: { resourceUri, visibility: ["app" as const] } });

  // The views send the environment they show, so a save lands where the person saw it.
  const target = z.string().optional().describe("Environment; defaults to the active one.");

  registerAppTool(
    server,
    "member_invite",
    {
      title: "Invite",
      description: "Invite someone by email. They join at their next sign-in with that verified email, even if they already have a workspace.",
      inputSchema: Invite,
      _meta: appOnly(VIEWS.workspace.uri),
    },
    async ({ email, role }) => {
      store.invite(ws, email, role);
      return ok(`Invited ${email} as ${role}. They join when they next connect genui and sign in with that email.`, workspaceState());
    },
  );

  registerAppTool(
    server,
    "invite_cancel",
    {
      title: "Cancel invite",
      description: "Cancel a pending invite.",
      inputSchema: z.object({ email: z.string() }),
      _meta: appOnly(VIEWS.workspace.uri),
    },
    async ({ email }) => {
      try {
        store.cancelInvite(ws, email);
        return ok(`Cancelled the invite for ${email}.`, workspaceState());
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "token_create",
    {
      title: "Create token",
      description: "Create a token: server for @genui/sdk on the company's MCP server, publish for CI, admin for the genui CLI. Shown once, in the view only.",
      inputSchema: z.object({ name: z.string().min(1).max(80), scope: z.enum(["server", "publish", "admin"]).default("server") }),
      _meta: appOnly(VIEWS.workspace.uri),
    },
    async ({ name, scope }) => {
      const token = store.createToken(ws, scope, name);
      // The text stays token-free: only the view shows the token.
      return ok(`Created the ${scope} token "${name}". Copy it now: it isn't shown again.`, workspaceState({ created: { name, scope, token } }));
    },
  );

  registerAppTool(
    server,
    "token_revoke",
    {
      title: "Revoke token",
      description: "Revoke a token. Servers or CI using it get 401 from their next request.",
      inputSchema: z.object({ id: z.string() }),
      _meta: appOnly(VIEWS.workspace.uri),
    },
    async ({ id }) => {
      try {
        store.revokeToken(ws, id);
        return ok("Revoked the token.", workspaceState());
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "public_set",
    {
      title: "Public MCP",
      description: "Turn the public end-user MCP on or off. Off: only servers with a server token can use it.",
      inputSchema: z.object({ enabled: z.boolean() }),
      _meta: appOnly(VIEWS.workspace.uri),
    },
    async ({ enabled }) => {
      store.setHosted(ws, enabled);
      return ok(
        enabled ? "The end-user MCP is public: anyone with its address can use it." : "The end-user MCP is private: only servers with a server token can use it.",
        workspaceState(),
      );
    },
  );

  registerAppTool(
    server,
    "recipe_save",
    {
      title: "Save recipe",
      description: "Make a drafted recipe live in an environment. Its servers pick it up on their next registry refresh.",
      inputSchema: z.object({ recipe: Recipe, environment: target }),
      _meta: appOnly(VIEWS.recipes.uri),
    },
    async ({ recipe, environment = env }) => {
      try {
        const replaced = store.saveRecipe(ws, environment, recipe);
        return ok(`${replaced ? "Updated" : "Saved"} /${recipe.name} in ${environment}. It reaches your servers within a minute.`, {
          mode: "draft",
          role: member.role,
          environment,
          recipe,
          replaces: false,
          saved: true,
        });
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "recipe_delete",
    {
      title: "Delete recipe",
      description: "Delete a recipe and its slash command from an environment.",
      inputSchema: z.object({ name: z.string(), environment: target }),
      _meta: appOnly(VIEWS.recipes.uri),
    },
    async ({ name, environment = env }) => {
      try {
        store.deleteRecipe(ws, environment, name);
        return ok(`Deleted /${name} from ${environment}.`, recipesState(environment));
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
      description: "Save an environment's theme. Its servers pick it up on their next registry refresh.",
      inputSchema: z.object({ theme: Theme.nullable(), environment: target }),
      _meta: appOnly(VIEWS.theme.uri),
    },
    async ({ theme, environment = env }) => {
      try {
        store.setTheme(ws, environment, theme);
        return ok(theme ? `Saved the ${environment} theme.` : `Cleared the ${environment} theme.`, { role: member.role, environment, theme });
      } catch (error) {
        return failed(error);
      }
    },
  );

  return server;
}
