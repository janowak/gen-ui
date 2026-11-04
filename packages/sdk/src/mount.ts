import type { Prompt, Tool } from "@modelcontextprotocol/client";
import {
  fromJsonSchema,
  ResourceTemplate,
  type JsonSchemaType,
  type McpServer,
  type RegisteredPrompt,
  type RegisteredResource,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import { resourceUri, type AppMcpClient } from "./client.js";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export interface AppMcpOptions {
  /** From `connectAppMcp`, once per process and environment: its URL picks the environment this server serves. */
  appMcp: AppMcpClient;
  /**
   * Long-lived (stateful) servers: re-sync when app-mcp's tools change (a publish, a theme, instructions or workflow
   * save) and notify the client with list_changed. Leave off for per-request servers.
   */
  watch?: boolean;
}

export interface AppMcpHandle {
  /** app-mcp tools currently on the server. */
  tools(): string[];
  /** Stops watching app-mcp. */
  close(): void;
}

type Mounted<H> = Map<string, { key: string; handle: H }>;

/** Brings registered items in line with `wanted`, re-registering any whose definition changed. Returns true if anything changed. */
function mirror<T extends { name: string }, H extends { remove(): void }>(
  mounted: Mounted<H>,
  wanted: T[],
  register: (item: T) => H,
): boolean {
  const next = new Map(wanted.map((item) => [item.name, item]));
  let changed = false;
  for (const [name, entry] of mounted) {
    const item = next.get(name);
    if (item && JSON.stringify(item) === entry.key) continue;
    entry.handle.remove();
    mounted.delete(name);
    changed = true;
  }
  for (const [name, item] of next) {
    if (mounted.has(name)) continue;
    mounted.set(name, { key: JSON.stringify(item), handle: register(item) });
    changed = true;
  }
  return changed;
}

/**
 * Puts app-mcp's tools (`render_form`, `render_chart`, `render_<component>`), their
 * `ui://` resources and the workflow prompts on your MCP server, next to your own tools. Calls are
 * forwarded to app-mcp. app-mcp's views call your tools through the host, so those never leave your server.
 */
export async function mountAppMcp(server: McpServer, { appMcp, watch = false }: AppMcpOptions): Promise<AppMcpHandle> {
  await appMcp.ready();
  const tools: Mounted<RegisteredTool> = new Map();
  const prompts: Mounted<RegisteredPrompt> = new Map();
  const resources = new Map<string, RegisteredResource>();

  const registerTool = (tool: Tool) =>
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
        ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) } : {}),
        annotations: tool.annotations,
        _meta: tool._meta,
      },
      (args) => appMcp.callTool(tool.name, args as Record<string, unknown>),
    );

  function registerPrompt(prompt: Prompt) {
    const args = prompt.arguments ?? [];
    const config = { title: prompt.title, description: prompt.description };
    if (!args.length) return server.registerPrompt(prompt.name, config, () => appMcp.getPrompt(prompt.name, {}));
    const argsSchema = fromJsonSchema<Record<string, string>>({
      type: "object",
      properties: Object.fromEntries(
        args.map((a) => [a.name, { type: "string", ...(a.description ? { description: a.description } : {}) }]),
      ),
      required: args.filter((a) => a.required).map((a) => a.name),
    });
    return server.registerPrompt(prompt.name, { ...config, argsSchema }, (values) => appMcp.getPrompt(prompt.name, values));
  }

  const registerResource = (uri: string) =>
    server.registerResource(uri, uri, { mimeType: appMcp.resource(uri)?.contents[0]?.mimeType ?? RESOURCE_MIME_TYPE }, () =>
      appMcp.readResource(uri),
    );

  // Earlier component versions, for old messages the host renders again: read from app-mcp.
  server.registerResource(
    "app-mcp component version",
    new ResourceTemplate("ui://app-mcp/c/{name}/{hash}", { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE },
    (uri) => appMcp.readResource(uri.href),
  );

  function sync() {
    const changed = { tools: false, resources: false, prompts: false };
    const snapshot = appMcp.snapshot();
    if (!snapshot) return changed;
    changed.tools = mirror(tools, snapshot.tools, registerTool);
    changed.prompts = mirror(prompts, snapshot.prompts, registerPrompt);
    const wanted = new Set(snapshot.tools.map(resourceUri).filter((uri): uri is string => uri !== undefined));
    for (const [uri, handle] of resources) {
      if (wanted.has(uri)) continue;
      handle.remove();
      resources.delete(uri);
      changed.resources = true;
    }
    for (const uri of wanted) {
      if (resources.has(uri)) continue;
      resources.set(uri, registerResource(uri));
      changed.resources = true;
    }
    return changed;
  }

  sync();
  const unsubscribe = watch
    ? appMcp.onChange(() => {
        try {
          const changed = sync();
          if (changed.tools) server.sendToolListChanged();
          if (changed.resources) server.sendResourceListChanged();
          if (changed.prompts) server.sendPromptListChanged();
        } catch (error) {
          console.warn(`[app-mcp] could not update app-mcp's tools: ${error}`);
        }
      })
    : () => {};

  return { tools: () => [...tools.keys()], close: unsubscribe };
}
