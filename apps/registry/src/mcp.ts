import { randomUUID } from "node:crypto";
import {
  Branding,
  EnvironmentName,
  isCommand,
  MAX_ENVIRONMENT_INSTRUCTIONS,
  MAX_INSTRUCTIONS,
  PREVIEW_META_KEY,
  serverInstructions,
  Theme,
  THEME_META_KEY,
  VIEW_CONTENT_KEY,
  VIEW_ID_META_KEY,
  Workflow,
  MAX_ICON_BYTES,
} from "@app-mcp/format";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { contentHash, mountAppMcp } from "@app-mcp/runtime";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { endUserPath } from "./api.js";
import { iconPath } from "./hosted.js";
import { RegistryError, type Membership, type Store, type WorkspaceSummary } from "./store.js";
import { builtInViews, MANAGEMENT_VIEWS, type Assets, type ManagementViewName } from "./views.js";

type ManagementViews = Record<ManagementViewName, { html: string; uri: string }>;
const hashed = new WeakMap<Assets, ManagementViews>();

/** Management views shipped with @app-mcp/ui, hashed once per process. */
function managementViews(assets: Assets): ManagementViews {
  let views = hashed.get(assets);
  if (!views) {
    const load = (name: ManagementViewName) => ({
      html: assets.views[name],
      uri: `ui://app-mcp-registry/${name}/${contentHash(JSON.stringify([assets.views[name], assets.viewMetadata?.[name]]))}`,
    });
    hashed.set(assets, (views = Object.fromEntries(MANAGEMENT_VIEWS.map((name) => [name, load(name)])) as ManagementViews));
  }
  return views;
}

const text = (value: string) => ({ type: "text" as const, text: value });

function ok(message: string, structuredContent: Record<string, unknown>) {
  return { content: [text(message)], structuredContent };
}

function failed(error: unknown) {
  const message = error instanceof RegistryError || error instanceof z.ZodError ? error.message : "Unexpected error";
  return { isError: true, content: [text(message)] };
}

/** The signed-in person's workspaces: theirs to list, create and (in the web console) switch between. */
export interface WorkspaceAccess {
  list(): Promise<WorkspaceSummary[]>;
  /** A new workspace they admin, if the sign-up gate lets them have one. Hosted registries only. */
  create?(name: string): Promise<Membership>;
  /** Makes another of theirs the active one, which the console and their connectors manage. */
  switch(workspaceId: string): Promise<Membership>;
}

/**
 * The registry's own MCP server, built per request for the signed-in person.
 * Members can browse, preview and pick the environment they look at. Admins also change workspace
 * settings (people, environments, the public MCP, the connector, tokens) with tools the model calls
 * directly, and save what end users get (theme, instructions, workflows) with app-only tools that run
 * only when a person clicks in the views. Token secrets are only ever returned to the tokens view.
 * `baseURL` is the registry's public URL, for the end-user MCP addresses the views show.
 * `toolsChanged` tells open clients to re-list, after a switch changes the preview tools.
 */
export async function createRegistryMcp(
  store: Store,
  member: Membership,
  { baseURL, assets, workspaces }: { baseURL: string; assets: Assets; workspaces?: WorkspaceAccess },
  toolsChanged: () => void = () => {},
): Promise<McpServer> {
  const server = new McpServer({ name: "app-mcp-registry", version: "0.1.0" });
  const VIEWS = managementViews(assets);
  const isAdmin = member.role === "admin";
  const ws = member.workspaceId;
  // Previews, theme, instructions and workflows show the member's active environment.
  const env = member.environment;

  // Built-in forms and charts as previews (preview_form / preview_chart) in the environment's theme.
  // No data tools here: those live on the customer's server, so only inline data works.
  const catalog = await store.catalog(ws, env);
  const theme = catalog.theme;
  await mountAppMcp(server, { views: builtInViews(assets), preview: true, theme: theme ?? undefined });

  // The summary and tokens views copy addresses and secrets to the clipboard, which the host must allow.
  const copies = new Set<ManagementViewName>(["workspace", "tokens"]);
  for (const [name, view] of Object.entries(VIEWS) as [ManagementViewName, ManagementViews[ManagementViewName]][]) {
    const base = assets.viewMetadata?.[name];
    const _meta = copies.has(name) ? { ...base, ui: { ...(base?.ui as object), permissions: { clipboardWrite: {} } } } : base;
    registerAppResource(server, view.uri, view.uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html, ...(_meta ? { _meta } : {}) }],
    }));
  }

  const componentsState = async (environment = env) => ({
    role: member.role,
    environment,
    environments: await store.listEnvironments(ws),
    components: await store.listComponents(ws),
    builtIns: (await store.environment(ws, environment))?.builtIns ?? true,
  });

  registerAppTool(
    server,
    "manage_components",
    {
      title: "Manage components",
      description:
        "Show the workspace's app-mcp components and the version each environment (prod, staging, …) serves, and whether the built-in forms and charts are on. " +
        "CI publishes versions to environments; nothing moves between them here. Admins can stop serving a component or turn the built-ins off from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.manager.uri } },
    },
    async () => {
      const state = await componentsState();
      const lines = state.components.map(
        (c) => `- ${c.name}: ${state.environments.map((e) => `${e} ${c.environments[e] ?? "—"}`).join(", ")}`,
      );
      const active = `Previews, theme, instructions and workflows show ${env}. Built-in forms and charts are ${state.builtIns ? "on" : "off"} in ${env}.`;
      return ok(state.components.length ? `Components:\n${lines.join("\n")}\n${active}` : `No components published yet. ${active}`, state);
    },
  );

  registerAppTool(
    server,
    "use_environment",
    {
      title: "Use environment",
      description:
        "Switch the environment your previews, theme, instructions and workflows show here (default prod). It changes only what you see in this connector; " +
        "end users get whatever each environment's own connector serves.",
      inputSchema: z.object({ name: z.string().describe("Environment name, e.g. staging.") }),
      _meta: { ui: { resourceUri: VIEWS.manager.uri } },
    },
    async ({ name }) => {
      try {
        await store.setActiveEnvironment(ws, member.userId, name);
        if (name !== env) toolsChanged();
        return ok(
          `Now showing ${name}: previews, theme, instructions and workflows follow it. If the preview tools still show the old versions, start a new chat.`,
          await componentsState(name),
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
      description: `Open the theme controller for ${env}: colors and radius used by every app-mcp form, chart and component there, with a live preview.`,
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.theme.uri } },
    },
    async () => ok(`Showing the ${env} theme controller.`, { role: member.role, environment: env, theme: await store.getTheme(ws, env) }),
  );

  const workflowsState = async (environment = env) => ({
    mode: "list",
    role: member.role,
    environment,
    workflows: await store.listWorkflows(ws, environment),
  });
  const describeWorkflow = (w: Workflow) =>
    isCommand(w) ? `- /${w.name} (${w.params.map((p) => p.name).join(", ")}): ${w.description}` : `- ${w.name}: ${w.description}`;

  registerAppTool(
    server,
    "manage_workflows",
    {
      title: "Workflows",
      description:
        `Show the workflows in ${env}: playbooks the AI follows, in the business's own words. A workflow with params is a slash command taking them; ` +
        "one without is part of the MCP instructions the AI always has. Admins edit and delete them from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.workflows.uri } },
    },
    async () => {
      const state = await workflowsState();
      return ok(
        state.workflows.length
          ? `Workflows in ${env}:\n${state.workflows.map(describeWorkflow).join("\n")}`
          : `No workflows in ${env} yet.`,
        state,
      );
    },
  );

  registerAppTool(
    server,
    "draft_workflow",
    {
      title: "Draft workflow",
      description:
        `Draft a workflow for review in ${env}. \`description\`: when to use it. \`instructions\`: the steps for the AI, naming the tools to use in order: ` +
        "render_form for forms (with the customer server's submit tool), render_chart, render_<component> for the workspace's components, and the customer server's own tools. " +
        "Add `params` only for what a user would type when starting it as a slash command; without params it is always-on guidance. " +
        "Nothing is saved: an admin reviews the draft and clicks Save. Workflows usually live in the repo next to the components and go out with app-mcp publish.",
      inputSchema: Workflow,
      _meta: { ui: { resourceUri: VIEWS.workflows.uri } },
    },
    async (workflow) =>
      ok(
        `Drafted ${isCommand(workflow) ? `/${workflow.name}` : workflow.name} for ${env}. ${isAdmin ? `Click Save to make it live in ${env}.` : "An admin must save it."}`,
        {
          mode: "draft",
          role: member.role,
          environment: env,
          workflow,
          replaces: Boolean(await store.getWorkflow(ws, env, workflow.name)),
        },
      ),
  );

  // How the end-user MCP presents itself in hosts' connector lists.
  const brandingState = async () => {
    const { icon, ...branding } = await store.branding(ws);
    return { ...branding, iconUrl: icon ? `${baseURL}${iconPath(ws)}?v=${icon.hash}` : null };
  };
  // Each environment's end-user MCP address: what hosts add as a connector, and APP_MCP_MCP_URL for @app-mcp/sdk.
  const addresses = async () =>
    (await store.listEnvironments(ws)).map((environment) => ({ environment, url: `${baseURL}${endUserPath(ws, environment)}` }));
  const access = (isPublic: boolean) =>
    isPublic
      ? "The end-user MCP is public: anyone with its address can add it as a connector, and servers use it with a server token."
      : "The end-user MCP is private: only servers with a server token can use it.";
  const listAddresses = (connectors: { environment: string; url: string }[]) =>
    connectors.map((c) => `- ${c.environment}: ${c.url}`).join("\n");

  // The workspace at a glance. People, tokens and the connector each have their own view and tools,
  // and admins change settings with plain tools the model calls (below).
  const workspaceState = async () => {
    const [workspace, branding, people, isPublic, connectors, components] = await Promise.all([
      store.workspace(ws),
      brandingState(),
      store.listMembers(ws),
      store.isHosted(ws),
      addresses(),
      store.listComponents(ws),
    ]);
    return {
      role: member.role,
      workspace: workspace!,
      title: branding.title ?? workspace!.name,
      iconUrl: branding.iconUrl,
      public: isPublic,
      connectors,
      counts: {
        members: people.members.length,
        invites: people.invites.length,
        components: components.length,
        ...(isAdmin ? { tokens: (await store.listTokens(ws)).length } : {}),
      },
    };
  };
  const describeWorkspace = (state: Awaited<ReturnType<typeof workspaceState>>) => {
    const { members, invites, components, tokens } = state.counts;
    const counts = [`${members} member${members === 1 ? "" : "s"}`, `${invites} pending invite${invites === 1 ? "" : "s"}`];
    counts.push(`${components} component${components === 1 ? "" : "s"}`);
    if (tokens !== undefined) counts.push(`${tokens} token${tokens === 1 ? "" : "s"}`);
    return `${state.workspace.name} (shown in hosts as "${state.title}"): ${counts.join(", ")}. ${access(state.public)}\nEnd-user MCP addresses:\n${listAddresses(state.connectors)}`;
  };

  registerAppTool(
    server,
    "show_workspace",
    {
      title: "Workspace",
      description:
        "Show the workspace at a glance: its name, whether its end-user MCP is public, each environment's end-user MCP address, and how many people, invites, components and tokens it has. " +
        "list_members, list_tokens and edit_connector show the details.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.workspace.uri } },
    },
    async () => {
      const state = await workspaceState();
      return ok(describeWorkspace(state), state);
    },
  );

  // People who manage the workspace, and invites waiting for a first sign-in.
  const membersState = async () => ({ role: member.role, me: member.userId, ...(await store.listMembers(ws)) });
  const describeMembers = ({ members, invites }: Awaited<ReturnType<typeof membersState>>) =>
    [
      ...members.map((m) => `- ${m.name ?? m.email ?? m.userId}${m.name && m.email ? ` <${m.email}>` : ""} (${m.role})`),
      ...invites.map((i) => `- ${i.email} (${i.role}, invited)`),
    ].join("\n");

  registerAppTool(
    server,
    "list_members",
    {
      title: "People",
      description:
        "List the people who manage the workspace and the pending invites. Admins change them with member_invite, invite_cancel, member_set_role and member_remove, or from the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.members.uri } },
    },
    async () => {
      const state = await membersState();
      return ok(`People:\n${describeMembers(state)}`, state);
    },
  );

  // Instructions: what the end-user MCP tells the model when a host connects, with the workflows added.
  const instructionsState = async (environment = env, draft?: string | null) => {
    const [saved, workflows] = await Promise.all([store.getInstructions(ws, environment), store.listWorkflows(ws, environment)]);
    const instructions = draft === undefined ? saved : draft;
    return {
      mode: draft === undefined ? "view" : "draft",
      role: member.role,
      environment,
      instructions,
      served: serverInstructions(instructions, workflows) ?? null,
      limit: MAX_INSTRUCTIONS,
    };
  };

  registerAppTool(
    server,
    "manage_instructions",
    {
      title: "Instructions",
      description:
        `Show ${env}'s MCP instructions: the overview hosts give the AI when someone adds the connector, and the full text they get with the workflows added. ` +
        "Use draft_instructions to propose changes.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.instructions.uri } },
    },
    async () => {
      const state = await instructionsState();
      return ok(
        state.served
          ? `What hosts get from ${env} (${state.served.length}/${MAX_INSTRUCTIONS} characters):\n${state.served}`
          : `No instructions or workflows in ${env} yet.`,
        state,
      );
    },
  );

  registerAppTool(
    server,
    "draft_instructions",
    {
      title: "Draft instructions",
      description:
        `Draft ${env}'s MCP instructions for review: a short overview of what this MCP helps with and which tools to prefer. ` +
        "Don't repeat the workflows; they are added after it. Nothing is saved: an admin reviews the draft and clicks Save.",
      inputSchema: z.object({ instructions: z.string().max(MAX_ENVIRONMENT_INSTRUCTIONS) }),
      _meta: { ui: { resourceUri: VIEWS.instructions.uri } },
    },
    async ({ instructions }) =>
      ok(
        `Drafted instructions for ${env}. ${isAdmin ? `Click Save to make them live in ${env}.` : "An admin must save them."}`,
        await instructionsState(env, instructions),
      ),
  );

  // Preview the version the active environment serves of each component, rendered with props the model provides.
  const bundles = await Promise.all(catalog.components.map((component) => store.resource(ws, component.hash)));
  for (const [i, component] of catalog.components.entries()) {
    const resource = bundles[i];
    if (!resource) continue;
    const { html, _meta } = resource;
    const uri = `ui://app-mcp-registry/preview/${component.name}/${component.hash}`;
    registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta }],
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
        const id = randomUUID();
        return {
          content: [text(`Previewing ${component.name}@${component.version}.`)],
          structuredContent: { [VIEW_CONTENT_KEY]: { id } },
          _meta: { [PREVIEW_META_KEY]: true, [VIEW_ID_META_KEY]: id, ...(theme ? { [THEME_META_KEY]: theme } : {}) },
        };
      },
    );
  }

  if (workspaces) registerWorkspaceTools(server, workspaces, ws, toolsChanged);

  if (!isAdmin) return server;

  const appOnly = (resourceUri: string) => ({ ui: { resourceUri, visibility: ["app" as const] } });

  // The views send the environment they show, so a save lands where the person saw it.
  const target = z.string().optional().describe("Environment; defaults to the active one.");

  registerAppTool(
    server,
    "component_remove",
    {
      title: "Stop serving component",
      description:
        "Stop serving a component in an environment. Its versions stay published; `app-mcp publish <name>@<version>` serves one again.",
      inputSchema: z.object({ name: z.string(), environment: target }),
      _meta: appOnly(VIEWS.manager.uri),
    },
    async ({ name, environment = env }) => {
      try {
        await store.removeComponent(ws, name, environment);
        if (environment === env) toolsChanged();
        return ok(
          `${environment} no longer serves ${name}. Its connectors drop render_${name} on their next refresh.`,
          await componentsState(environment),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "built_ins_set",
    {
      title: "Built-in forms and charts",
      description: "Turn the built-in render_form and render_chart on or off in an environment's end-user MCP.",
      inputSchema: z.object({ enabled: z.boolean(), environment: target }),
      _meta: appOnly(VIEWS.manager.uri),
    },
    async ({ enabled, environment = env }) => {
      try {
        await store.setBuiltIns(ws, environment, enabled);
        return ok(
          enabled
            ? `${environment} offers the built-in forms and charts again.`
            : `${environment} no longer offers the built-in forms and charts: only your components.`,
          await componentsState(environment),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  // Workspace settings: plain tools the model calls directly, which the views call too. Token secrets are the
  // exception: the model can create a token, but its secret is made and shown only in the tokens view.
  const guarded =
    <Args>(run: (args: Args) => Promise<ReturnType<typeof ok>>) =>
    async (args: Args) => {
      try {
        return await run(args);
      } catch (error) {
        return failed(error);
      }
    };
  const Role = z.enum(["member", "admin"]);

  server.registerTool(
    "workspace_rename",
    {
      title: "Rename workspace",
      description: "Rename the workspace. Hosts show the connector title instead when one is set (connector_set).",
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
    },
    guarded(async ({ name }) => {
      await store.renameWorkspace(ws, name);
      return ok(`Renamed the workspace to "${name}".`, await workspaceState());
    }),
  );

  server.registerTool(
    "public_set",
    {
      title: "Public MCP",
      description: "Turn the public end-user MCP on or off. Off: only servers with a server token can use it.",
      inputSchema: z.object({ enabled: z.boolean() }),
    },
    guarded(async ({ enabled }) => {
      await store.setHosted(ws, enabled);
      return ok(access(enabled), await workspaceState());
    }),
  );

  server.registerTool(
    "environment_create",
    {
      title: "Create environment",
      description:
        "Add an environment next to prod, e.g. staging. It gets its own end-user MCP address; CI publishes components and workflows to it.",
      inputSchema: z.object({ name: EnvironmentName }),
    },
    guarded(async ({ name }) => {
      await store.createEnvironment(ws, name);
      return ok(`Created ${name}. Its end-user MCP: ${baseURL}${endUserPath(ws, name)}`, await workspaceState());
    }),
  );

  server.registerTool(
    "member_invite",
    {
      title: "Invite",
      description:
        "Invite someone by email. They join at their next sign-in with that verified email, even if they already have a workspace.",
      inputSchema: z.object({ email: z.email(), role: Role.default("member") }),
    },
    guarded(async ({ email, role }) => {
      await store.invite(ws, email, role);
      return ok(`Invited ${email} as ${role}. They join when they next connect app-mcp and sign in with that email.`, await membersState());
    }),
  );

  server.registerTool(
    "invite_cancel",
    { title: "Cancel invite", description: "Cancel a pending invite.", inputSchema: z.object({ email: z.string() }) },
    guarded(async ({ email }) => {
      await store.cancelInvite(ws, email);
      return ok(`Cancelled the invite for ${email}.`, await membersState());
    }),
  );

  server.registerTool(
    "member_set_role",
    {
      title: "Change role",
      description: "Make a member an admin or a member, by the email they signed in with. The workspace always keeps an admin.",
      inputSchema: z.object({ email: z.string(), role: Role }),
    },
    guarded(async ({ email, role }) => {
      await store.setRole(ws, (await store.memberByEmail(ws, email)).userId, role);
      return ok(`${email} is now ${role === "admin" ? "an admin" : "a member"}.`, await membersState());
    }),
  );

  server.registerTool(
    "member_remove",
    {
      title: "Remove member",
      description:
        "Remove someone from the workspace, by the email they signed in with. Their connector stops working from its next request. The workspace always keeps an admin.",
      inputSchema: z.object({ email: z.string() }),
    },
    guarded(async ({ email }) => {
      await store.removeMember(ws, (await store.memberByEmail(ws, email)).userId);
      return ok(`Removed ${email} from the workspace.`, await membersState());
    }),
  );

  // How hosts list the end-user MCP. Unlike the other settings, the icon is a file: it's uploaded in the view.
  const connectorState = async (draft?: Record<string, unknown>) => ({
    workspace: (await store.workspace(ws))!,
    branding: await brandingState(),
    ...(draft ? { draft } : {}),
  });
  const ConnectorFields = z.object({
    title: Branding.shape.title.unwrap().nullable().optional().describe('Display name, e.g. "Acme Support"; null clears it.'),
    description: Branding.shape.description.unwrap().nullable().optional().describe("What the connector does; null clears it."),
    websiteUrl: Branding.shape.websiteUrl.unwrap().nullable().optional().describe("null clears it."),
  });

  registerAppTool(
    server,
    "edit_connector",
    {
      title: "Connector",
      description:
        "Show how hosts like Claude and ChatGPT list the end-user MCP: its icon, title, description and website, in a form. " +
        "Pass fields to prefill the form for the admin to review; connector_set saves them without it.",
      inputSchema: ConnectorFields,
      _meta: { ui: { resourceUri: VIEWS.connector.uri } },
    },
    async (draft) => {
      const state = await connectorState(Object.keys(draft).length ? draft : undefined);
      const { title, description, websiteUrl, iconUrl } = state.branding;
      const shown = [
        `Title: ${title ?? `${state.workspace.name} (the workspace name)`}`,
        `Description: ${description ?? "none"}`,
        `Website: ${websiteUrl ?? "none"}`,
        `Icon: ${iconUrl ? "set" : "none"}`,
      ];
      return ok(
        `${state.draft ? "Prefilled the connector form; the admin saves it. " : ""}Hosts list the end-user MCP as:\n${shown.join("\n")}`,
        state,
      );
    },
  );

  server.registerTool(
    "connector_set",
    {
      title: "Set connector",
      description:
        "Change how hosts list the end-user MCP. Only the fields you pass change; null clears one. Hosts show it the next time they connect. The icon is uploaded in edit_connector.",
      inputSchema: ConnectorFields,
    },
    guarded(async (fields) => {
      const { icon: _, ...current } = await store.branding(ws);
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) next[key] = value ?? undefined;
      await store.setBranding(ws, Branding.parse(next));
      return ok("Saved the connector. Hosts show it the next time they connect.", await connectorState());
    }),
  );

  registerAppTool(
    server,
    "connector_icon_set",
    {
      title: "Set connector icon",
      description: "Replace the connector icon (base64 PNG, JPEG, WebP or SVG), or remove it with null.",
      inputSchema: z.object({
        icon: z
          .string()
          .max(Math.ceil(MAX_ICON_BYTES / 3) * 4)
          .nullable(),
      }),
      _meta: appOnly(VIEWS.connector.uri),
    },
    guarded(async ({ icon }) => {
      await store.setIcon(ws, icon === null ? null : new Uint8Array(Buffer.from(icon, "base64")));
      return ok(icon === null ? "Removed the connector icon." : "Saved the connector icon.", await connectorState());
    }),
  );

  // Tokens. A token made here has no secret until an admin clicks Reveal in the tokens view: the secret is
  // made then and returned once, to the view only, so it never reaches the model or the chat history.
  const tokensState = async (highlight?: string) => ({
    tokens: await store.listTokens(ws),
    connectors: await addresses(),
    ...(highlight ? { highlight } : {}),
  });
  const describeTokens = ({ tokens }: Awaited<ReturnType<typeof tokensState>>) =>
    tokens.length
      ? tokens
          .map(
            (t) =>
              `- ${t.name} (${t.scope}${t.environments ? `, ${t.environments.join(", ")}` : ""}, id ${t.id})${t.revealed ? "" : ": not revealed yet"}`,
          )
          .join("\n")
      : "No tokens yet.";

  registerAppTool(
    server,
    "list_tokens",
    {
      title: "Tokens",
      description:
        "List the workspace's tokens: server (your MCP server forwards app-mcp's tools with @app-mcp/sdk), publish (CI runs app-mcp publish) and admin (the app-mcp CLI). " +
        "Secrets are never shown here; an admin reveals a new token's secret once, in the view.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: VIEWS.tokens.uri } },
    },
    async () => {
      const state = await tokensState();
      return ok(describeTokens(state), state);
    },
  );

  registerAppTool(
    server,
    "token_create",
    {
      title: "Create token",
      description:
        "Create a token: server for @app-mcp/sdk on the company's MCP server, publish for CI, admin for the app-mcp CLI. " +
        "It has no secret yet: the admin clicks Reveal in the view to see and copy it once. The secret never comes back to you.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80).describe('What uses it, e.g. "prod server".'),
        scope: z.enum(["server", "publish", "admin"]).default("server"),
        environments: z.array(EnvironmentName).min(1).optional().describe("Publish tokens only: the environments it may publish to."),
      }),
      _meta: { ui: { resourceUri: VIEWS.tokens.uri } },
    },
    guarded(async ({ name, scope, environments }) => {
      if (environments && scope !== "publish") throw new RegistryError(400, "Only publish tokens can be limited to environments");
      const id = await store.addToken(ws, scope, name, environments);
      return ok(
        `Created the ${scope} token "${name}". It has no secret yet: click Reveal in the view to see it once and copy it.`,
        await tokensState(id),
      );
    }),
  );

  server.registerTool(
    "token_revoke",
    {
      title: "Revoke token",
      description: "Revoke a token by id (from list_tokens). Servers or CI using it get 401 from their next request.",
      inputSchema: z.object({ id: z.string() }),
    },
    guarded(async ({ id }) => {
      await store.revokeToken(ws, id);
      return ok("Revoked the token.", await tokensState());
    }),
  );

  // The only tools that return a secret: app-only, so just a click in the view runs them. The text stays secret-free.
  for (const rotate of [false, true]) {
    registerAppTool(
      server,
      rotate ? "token_rotate" : "token_reveal",
      {
        title: rotate ? "Rotate token" : "Reveal token",
        description: rotate
          ? "Give a token a new secret, shown once; the old one stops working."
          : "Make a new token's secret and show it once.",
        inputSchema: z.object({ id: z.string() }),
        _meta: appOnly(VIEWS.tokens.uri),
      },
      guarded(async ({ id }) => {
        const secret = await store.revealToken(ws, id, { rotate });
        return ok(rotate ? "Rotated the token: the old secret no longer works." : "Revealed the token.", {
          ...(await tokensState(id)),
          secret: { id, token: secret },
        });
      }),
    );
  }

  registerAppTool(
    server,
    "instructions_save",
    {
      title: "Save instructions",
      description: "Replace an environment's MCP instructions; empty clears them. Hosts get them on their next connection.",
      inputSchema: z.object({ instructions: z.string().max(MAX_ENVIRONMENT_INSTRUCTIONS).nullable(), environment: target }),
      _meta: appOnly(VIEWS.instructions.uri),
    },
    async ({ instructions, environment = env }) => {
      try {
        await store.setInstructions(ws, environment, instructions);
        return ok(`Saved the instructions in ${environment}. Hosts get them on their next connection.`, {
          ...(await instructionsState(environment)),
          saved: true,
        });
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerAppTool(
    server,
    "workflow_save",
    {
      title: "Save workflow",
      description: "Make a drafted workflow live in an environment. Its servers pick it up on their next registry refresh.",
      inputSchema: z.object({ workflow: Workflow, environment: target }),
      _meta: appOnly(VIEWS.workflows.uri),
    },
    async ({ workflow, environment = env }) => {
      try {
        const replaced = await store.saveWorkflow(ws, environment, workflow);
        return ok(`${replaced ? "Updated" : "Saved"} ${workflow.name} in ${environment}. It reaches your servers within a minute.`, {
          mode: "draft",
          role: member.role,
          environment,
          workflow,
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
    "workflow_delete",
    {
      title: "Delete workflow",
      description: "Delete a workflow, and its slash command if it has params, from an environment.",
      inputSchema: z.object({ name: z.string(), environment: target }),
      _meta: appOnly(VIEWS.workflows.uri),
    },
    async ({ name, environment = env }) => {
      try {
        await store.deleteWorkflow(ws, environment, name);
        return ok(`Deleted ${name} from ${environment}.`, await workflowsState(environment));
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
        await store.setTheme(ws, environment, theme);
        return ok(theme ? `Saved the ${environment} theme.` : `Cleared the ${environment} theme.`, {
          role: member.role,
          environment,
          theme,
        });
      } catch (error) {
        return failed(error);
      }
    },
  );

  return server;
}

/**
 * Listing, creating and switching the person's workspaces. Members and admins alike. The console and
 * every connector the person added show their active workspace, so a switch in one shows in the others.
 */
function registerWorkspaceTools(server: McpServer, workspaces: WorkspaceAccess, current: string, toolsChanged: () => void): void {
  const describe = (list: WorkspaceSummary[]) =>
    list.map((w) => `- ${w.name} (${w.role}${w.id === current ? ", current" : ""}): ${w.id}`).join("\n");
  const state = async () => ({ current, canCreate: Boolean(workspaces.create), workspaces: await workspaces.list() });

  server.registerTool(
    "list_workspaces",
    {
      title: "Your workspaces",
      description:
        'List the workspaces you belong to, with your role in each. The tools here manage the one marked "current"; switch_workspace changes it.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await state();
      return ok(`Your workspaces:\n${describe(result.workspaces)}`, result);
    },
  );

  const { create } = workspaces;
  if (create)
    server.registerTool(
      "create_workspace",
      {
        title: "Create workspace",
        description:
          "Create a new, empty workspace that you admin, e.g. to keep demos apart from a product. It has its own components, " +
          "environments, people, tokens and end-user MCP. It becomes your current workspace.",
        inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
      },
      async ({ name }) => {
        try {
          const created = await create(name);
          toolsChanged();
          return ok(`Created ${name} (${created.workspaceId}). It is now your current workspace.`, {
            ...(await state()),
            current: created.workspaceId,
          });
        } catch (error) {
          return failed(error);
        }
      },
    );

  server.registerTool(
    "switch_workspace",
    {
      title: "Switch workspace",
      description:
        "Manage another of your workspaces: the tools here, the web console and your other app-mcp connectors all move to it. " +
        "If the preview tools still show the old workspace, start a new chat.",
      inputSchema: z.object({ workspace: z.string().min(1).describe("Workspace id, from list_workspaces.") }),
    },
    async ({ workspace }) => {
      try {
        const { role } = await workspaces.switch(workspace);
        if (workspace !== current) toolsChanged();
        const name = (await workspaces.list()).find((w) => w.id === workspace)?.name ?? workspace;
        return ok(`Now managing ${name} (${role}).`, { current: workspace, workspaces: await workspaces.list() });
      } catch (error) {
        return failed(error);
      }
    },
  );
}
