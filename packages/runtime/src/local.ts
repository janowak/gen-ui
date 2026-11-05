import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  ComponentManifest,
  MAX_PUBLISH_BYTES,
  MAX_ENVIRONMENT_INSTRUCTIONS,
  MAX_INSTRUCTIONS,
  serverInstructions,
  Theme,
  Workflow,
  type Catalog,
} from "@app-mcp/format";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { CatalogSource, Snapshot } from "./runtime.js";
import { contentHash } from "./views.js";

/** A component as it sits on disk, ready to publish or serve. */
export interface ComponentDir {
  manifest: ComponentManifest;
  html: string;
  /** Content hash of the bundle, as the registry computes it. */
  hash: string;
  manifestPath: string;
  bundlePath: string;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const issues = (error: z.ZodError) => error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`invalid JSON in ${path}: ${message(cause)}`);
  }
}

/**
 * Reads a component directory: a hand-written `app-mcp.component.json` next to the sources, else the
 * one @app-mcp/kit/vite generates into dist/. The bundle is `bundle` from the manifest, relative to
 * the manifest, or dist/index.html. Throws with a message for the developer.
 */
export async function readComponentDir(dir: string): Promise<ComponentDir> {
  const root = resolve(dir);
  let manifestPath = "";
  let text: string | undefined;
  for (const candidate of [resolve(root, "app-mcp.component.json"), resolve(root, "dist/app-mcp.component.json")]) {
    text = await readFile(candidate, "utf8").catch(() => undefined);
    manifestPath = candidate;
    if (text !== undefined) break;
  }
  if (text === undefined) throw new Error(`no app-mcp.component.json in ${root} or its dist/; build it first`);

  const raw = parseJson(text, manifestPath) as Record<string, unknown>;
  const parsed = ComponentManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid manifest ${manifestPath}:\n${issues(parsed.error)}`);

  const bundlePath = resolve(dirname(manifestPath), typeof raw.bundle === "string" ? raw.bundle : "dist/index.html");
  const html = await readFile(bundlePath, "utf8").catch(() => undefined);
  if (html === undefined) throw new Error(`bundle not found at ${bundlePath}; build it first`);
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_PUBLISH_BYTES) throw new Error(`${bundlePath} is ${bytes} bytes; the build budget is ${MAX_PUBLISH_BYTES}`);

  return { manifest: parsed.data, html, hash: contentHash(html), manifestPath, bundlePath };
}

async function readSchema<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`${path} not found`);
  const parsed = schema.safeParse(parseJson(text, path));
  if (!parsed.success) throw new Error(`invalid ${path}:\n${issues(parsed.error)}`);
  return parsed.data;
}

/** Workflow files sit next to the components they use: `<name>.workflow.md`, in a component dir or its workflows/. */
export const WORKFLOW_FILE = ".workflow.md";

/** A workflow as it sits on disk, ready to publish or serve. */
export interface WorkflowFile {
  workflow: Workflow;
  path: string;
}

/**
 * Parses a workflow file: YAML frontmatter (title, description, params; name defaults to the file
 * name) and the instructions as the Markdown body. A `.json` file holds the workflow as is.
 * Throws with a message for the developer.
 */
export function parseWorkflowFile(text: string, path: string): Workflow {
  let raw: Record<string, unknown>;
  if (path.endsWith(".json")) raw = parseJson(text, path) as Record<string, unknown>;
  else {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`invalid workflow ${path}: expected YAML frontmatter between --- lines, then the instructions`);
    try {
      raw = { ...(parseYaml(match[1]!) as Record<string, unknown> | null), instructions: match[2]!.trim() };
    } catch (cause) {
      throw new Error(`invalid workflow ${path}: ${message(cause)}`);
    }
  }
  const name = raw.name ?? basename(path).replace(/\.workflow\.md$|\.md$|\.json$/, "");
  const parsed = Workflow.safeParse({ ...raw, name });
  if (!parsed.success) throw new Error(`invalid workflow ${path}:\n${issues(parsed.error)}`);
  return parsed.data;
}

export async function readWorkflowFile(path: string): Promise<WorkflowFile> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`${path} not found`);
  return { workflow: parseWorkflowFile(text, path), path };
}

/** The `*.workflow.md` files in dir and dir/workflows/, by name. Throws when two share a name. */
export async function readWorkflowDir(dir: string): Promise<WorkflowFile[]> {
  const root = resolve(dir);
  const paths: string[] = [];
  for (const folder of [root, resolve(root, "workflows")]) {
    const entries = await readdir(folder).catch(() => [] as string[]);
    paths.push(...entries.filter((entry) => entry.endsWith(WORKFLOW_FILE)).map((entry) => resolve(folder, entry)));
  }
  const files = await Promise.all(paths.sort().map((path) => readWorkflowFile(path)));
  const seen = new Map<string, string>();
  for (const { workflow, path } of files) {
    const other = seen.get(workflow.name);
    if (other) throw new Error(`two workflows are named ${workflow.name}: ${other} and ${path}`);
    seen.set(workflow.name, path);
  }
  return files.sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));
}

export interface LocalCatalogOptions {
  /** Component directories, as `app-mcp publish` takes them, with their workflow files. A dir may hold only workflows. */
  dirs: string[];
  /** Theme JSON file. */
  theme?: string;
  /** Markdown file: the environment's MCP instructions. Workflows without params are added after it. */
  instructions?: string;
}

/** Something that didn't load. The rest is served without it. */
export interface Problem {
  path: string;
  message: string;
}

export interface Reload {
  /** Whether what's served changed (and the revision moved). */
  changed: boolean;
  /** What changed or newly broke, one line each, for the developer. */
  lines: string[];
}

export interface LocalCatalog extends CatalogSource {
  /** Reads every file again. */
  reload(): Promise<Reload>;
  /** Bumped on every change to what's served. */
  revision(): number;
  components(): ComponentDir[];
  problems(): Problem[];
  /** The server instructions hosts get: the environment's, with the workflows added. */
  instructions(): string | undefined;
}

interface State {
  components: ComponentDir[];
  theme: Theme | null;
  instructions: string | null;
  workflows: Workflow[];
  problems: Problem[];
}

/** What's served, without paths or HTML, so a rebuild with the same output doesn't count as a change. */
const signature = (state: State) =>
  JSON.stringify({
    components: state.components.map((c) => [c.manifest, c.hash]),
    theme: state.theme,
    instructions: state.instructions,
    workflows: state.workflows,
  });

async function load(options: LocalCatalogOptions): Promise<State> {
  const problems: Problem[] = [];
  const components: ComponentDir[] = [];
  const workflows: Workflow[] = [];
  for (const dir of options.dirs) {
    let hasWorkflows = false;
    try {
      for (const { workflow, path } of await readWorkflowDir(dir)) {
        hasWorkflows = true;
        if (workflows.some((w) => w.name === workflow.name))
          problems.push({ path, message: `workflow "${workflow.name}" is defined twice; skipped` });
        else workflows.push(workflow);
      }
    } catch (cause) {
      problems.push({ path: resolve(dir), message: message(cause) });
    }
    try {
      const component = await readComponentDir(dir).catch((cause: unknown) => {
        // A dir with only workflows is fine.
        if (hasWorkflows && message(cause).startsWith("no app-mcp.component.json")) return undefined;
        throw cause;
      });
      if (!component) continue;
      const taken = components.find((c) => c.manifest.name === component.manifest.name);
      if (taken) throw new Error(`component "${component.manifest.name}" is already served from ${taken.manifestPath}`);
      components.push(component);
    } catch (cause) {
      problems.push({ path: resolve(dir), message: message(cause) });
    }
  }

  let theme: Theme | null = null;
  if (options.theme) {
    try {
      theme = await readSchema(options.theme, Theme);
    } catch (cause) {
      problems.push({ path: resolve(options.theme), message: message(cause) });
    }
  }

  let instructions: string | null = null;
  if (options.instructions) {
    const text = await readFile(options.instructions, "utf8").catch(() => undefined);
    if (text === undefined) problems.push({ path: resolve(options.instructions), message: `${options.instructions} not found` });
    else if (text.trim().length > MAX_ENVIRONMENT_INSTRUCTIONS)
      problems.push({
        path: resolve(options.instructions),
        message: `${options.instructions} is over ${MAX_ENVIRONMENT_INSTRUCTIONS} characters; the registry rejects it`,
      });
    instructions = text?.trim() || null;
  }
  const length = serverInstructions(instructions, workflows)?.length ?? 0;
  if (length > MAX_INSTRUCTIONS) {
    problems.push({
      path: resolve(options.instructions ?? "."),
      message: `the server instructions are ${length} characters; the registry allows ${MAX_INSTRUCTIONS}. Shorten them or give workflows params`,
    });
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { components, theme, instructions, workflows, problems };
}

/** Describes what changed between two loads, plus problems that are new. */
function describe(before: State, after: State): string[] {
  const lines: string[] = [];
  for (const c of after.components) {
    const old = before.components.find((b) => b.manifest.name === c.manifest.name);
    if (!old) lines.push(`${c.manifest.name}@${c.manifest.version} added (${c.hash})`);
    else if (old.hash !== c.hash || JSON.stringify(old.manifest) !== JSON.stringify(c.manifest))
      lines.push(`${c.manifest.name}@${c.manifest.version} reloaded (${c.hash})`);
  }
  for (const b of before.components)
    if (!after.components.some((c) => c.manifest.name === b.manifest.name)) lines.push(`${b.manifest.name} removed`);
  if (JSON.stringify(before.theme) !== JSON.stringify(after.theme)) lines.push("theme reloaded");
  if (JSON.stringify(before.workflows) !== JSON.stringify(after.workflows))
    lines.push(`workflows reloaded (${after.workflows.map((w) => w.name).join(", ") || "none"})`);
  if (before.instructions !== after.instructions) lines.push("instructions reloaded");
  for (const p of after.problems) {
    if (!before.problems.some((b) => b.path === p.path && b.message === p.message)) lines.push(`problem: ${p.message}`);
  }
  return lines;
}

/**
 * Components, workflows, theme and instructions read from files, for `app-mcp serve`. A file that doesn't load
 * is reported in `problems()` and left out; the next `reload()` tries it again. Every bundle seen
 * since start stays available by hash, so messages rendered before a rebuild still load.
 */
export async function localCatalog(options: LocalCatalogOptions): Promise<LocalCatalog> {
  let state = await load(options);
  let revision = 1;
  const seen = new Map<string, string>();
  const remember = () => state.components.forEach((c) => seen.set(c.hash, c.html));
  remember();

  return {
    async snapshot(environment): Promise<Snapshot> {
      const catalog: Catalog = {
        environment,
        theme: state.theme,
        components: state.components.map(({ manifest, hash }) => ({ name: manifest.name, version: manifest.version, hash, manifest })),
        instructions: state.instructions,
        workflows: state.workflows,
      };
      return { catalog, bundles: Object.fromEntries(state.components.map((c) => [c.hash, c.html])) };
    },
    async bundle(hash) {
      return seen.get(hash);
    },
    async reload() {
      const next = await load(options);
      const lines = describe(state, next);
      const changed = signature(next) !== signature(state);
      state = next;
      remember();
      if (changed) revision++;
      return { changed, lines };
    },
    revision: () => revision,
    components: () => state.components,
    problems: () => state.problems,
    instructions: () => serverInstructions(state.instructions, state.workflows),
  };
}
