import { COMPONENT_CONTRACT, ComponentManifest, type ComponentCsp } from "@app-mcp/format";
import { z } from "zod";

export interface ComponentDefinition<P extends z.ZodObject = z.ZodObject, T extends string = string> {
  /** Lowercase letters, digits and _. Becomes the tool `render_<name>`. */
  name: string;
  /** x.y.z. Removing a prop or adding a required one needs a major version. */
  version: string;
  title?: string;
  /** What the model reads to decide when to show the component. */
  description: string;
  /** Props the model passes. Validated in the view and published as the tool's JSON Schema. */
  props: P;
  /** Tools on the host MCP server the component calls (typed `tools.call` names, mocked by `app-mcp dev`). */
  tools: readonly T[];
  csp?: ComponentCsp;
}

/**
 * The one place a component is described: the view validates props with it, and the Vite
 * plugin turns it into `app-mcp.component.json`.
 */
export function defineComponent<P extends z.ZodObject, const T extends string = never>(
  definition: Omit<ComponentDefinition<P, T>, "tools"> & { tools?: readonly T[] },
): ComponentDefinition<P, T> {
  return { ...definition, tools: definition.tools ?? [] };
}

/** The manifest the registry stores. Throws with readable issues if the definition is invalid. */
export function toManifest(component: ComponentDefinition): ComponentManifest {
  const props = z.toJSONSchema(component.props, { io: "input" }) as Record<string, unknown>;
  delete props.$schema;
  const parsed = ComponentManifest.safeParse({
    name: component.name,
    version: component.version,
    title: component.title,
    description: component.description,
    props,
    tools: [...component.tools],
    csp: component.csp,
    contract: COMPONENT_CONTRACT,
  });
  if (!parsed.success) {
    throw new Error(`invalid component definition:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}
