import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { z } from "zod";
import type { ComponentDefinition } from "./define.js";
import { createRuntime, type ComponentContext, type RuntimeOptions } from "./runtime.js";
import { THEME_VARIABLES, themeVariables } from "./theme.js";

/**
 * Connects a component to its MCP Apps host and calls `render` with the same live context
 * whenever it changes: props stream in or complete, the render result and workspace theme
 * arrive, the host theme changes, or state is set. Host styles (`--color-*`, fonts, dark mode)
 * and the workspace theme (`--genui-*`) are applied to the document before each render.
 */
export function mount<P extends z.ZodObject, T extends string>(
  component: ComponentDefinition<P, T>,
  render: (ctx: ComponentContext<z.output<P>, T>) => void,
  options: RuntimeOptions = {},
): ComponentContext<z.output<P>, T> {
  const app = new App({ name: `genui-${component.name}`, version: component.version });
  const root = document.documentElement;
  let host: McpUiHostContext | undefined;
  let themed: string | undefined;

  function update() {
    const next = app.getHostContext();
    if (next && next !== host) {
      host = next;
      if (next.theme) applyDocumentTheme(next.theme);
      if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
      if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
    }
    const vars = themeVariables(runtime.workspaceTheme(), runtime.context.theme);
    const key = JSON.stringify(vars);
    if (key !== themed) {
      themed = key;
      for (const name of THEME_VARIABLES) root.style.removeProperty(name);
      for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    }
    render(runtime.context);
  }

  const runtime = createRuntime(app, component, update, options);
  update();
  app.connect().then(update, (cause: unknown) =>
    runtime.fail(`Could not connect to the chat host: ${cause instanceof Error ? cause.message : String(cause)}`),
  );
  return runtime.context;
}
