import { relative, resolve } from "node:path";
import { runnerImport } from "vite";
import { toManifest, type ComponentDefinition } from "./define.js";

export const DEFAULT_COMPONENT = "src/component.ts";

/**
 * Loads the component definition module fresh (no module cache) and returns its manifest.
 * Throws with a message that names the file.
 */
export async function loadManifest(root: string, component = DEFAULT_COMPONENT) {
  const file = resolve(root, component);
  const where = relative(root, file);
  let definition: ComponentDefinition | undefined;
  try {
    const { module } = await runnerImport<{ default?: ComponentDefinition }>(file, { configFile: false, root, logLevel: "error" });
    definition = module.default;
  } catch (cause) {
    throw new Error(`could not load ${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!definition) throw new Error(`${where} must default-export defineComponent({ ... }).`);
  try {
    return toManifest(definition);
  } catch (cause) {
    throw new Error(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
