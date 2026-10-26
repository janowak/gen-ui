import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ComponentManifest, Guide, MAX_BUNDLE_BYTES, Recipe, Theme, type Catalog, type WorkflowPrompt } from "@genui/format";
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
 * Reads a component directory: a hand-written `genui.component.json` next to the sources, else the
 * one @genui/kit/vite generates into dist/. The bundle is `bundle` from the manifest, relative to
 * the manifest, or dist/index.html. Throws with a message for the developer.
 */
export async function readComponentDir(dir: string): Promise<ComponentDir> {
  const root = resolve(dir);
  let manifestPath = "";
  let text: string | undefined;
  for (const candidate of [resolve(root, "genui.component.json"), resolve(root, "dist/genui.component.json")]) {
    text = await readFile(candidate, "utf8").catch(() => undefined);
    manifestPath = candidate;
    if (text !== undefined) break;
  }
  if (text === undefined) throw new Error(`no genui.component.json in ${root} or its dist/; build it first`);

  const raw = parseJson(text, manifestPath) as Record<string, unknown>;
  const parsed = ComponentManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid manifest ${manifestPath}:\n${issues(parsed.error)}`);

  const bundlePath = resolve(dirname(manifestPath), typeof raw.bundle === "string" ? raw.bundle : "dist/index.html");
  const html = await readFile(bundlePath, "utf8").catch(() => undefined);
  if (html === undefined) throw new Error(`bundle not found at ${bundlePath}; build it first`);
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_BUNDLE_BYTES) throw new Error(`${bundlePath} is ${bytes} bytes; the registry accepts up to ${MAX_BUNDLE_BYTES}`);

  return { manifest: parsed.data, html, hash: contentHash(html), manifestPath, bundlePath };
}

async function readSchema<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`${path} not found`);
  const parsed = schema.safeParse(parseJson(text, path));
  if (!parsed.success) throw new Error(`invalid ${path}:\n${issues(parsed.error)}`);
  return parsed.data;
}

/** One recipe file, or every `*.json` in a directory. */
async function recipeFiles(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${path} not found`);
  if (!info.isDirectory()) return [path];
  return (await readdir(path))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(path, file));
}

export interface LocalCatalogOptions {
  /** Component directories, as `genui publish` takes them. */
  dirs: string[];
  /** Theme JSON file. */
  theme?: string;
  /** A recipe JSON file, or a directory of them. */
  recipes?: string;
  /** Guide JSON file: the MCP's instructions and workflow prompts. */
  guide?: string;
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
  /** The environment's instructions, for the MCP server's `instructions`. */
  instructions(): string | undefined;
}

interface State {
  components: ComponentDir[];
  theme: Theme | null;
  recipes: Recipe[];
  guide: { instructions: string | null; prompts: WorkflowPrompt[] };
  problems: Problem[];
}

/** What's served, without paths or HTML, so a rebuild with the same output doesn't count as a change. */
const signature = (state: State) =>
  JSON.stringify({ components: state.components.map((c) => [c.manifest, c.hash]), theme: state.theme, recipes: state.recipes, guide: state.guide });

async function load(options: LocalCatalogOptions): Promise<State> {
  const problems: Problem[] = [];
  const components: ComponentDir[] = [];
  for (const dir of options.dirs) {
    try {
      const component = await readComponentDir(dir);
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

  const recipes: Recipe[] = [];
  if (options.recipes) {
    try {
      for (const file of await recipeFiles(options.recipes)) {
        try {
          const recipe = await readSchema(file, Recipe);
          if (recipes.some((r) => r.name === recipe.name)) throw new Error(`recipe "${recipe.name}" is defined twice`);
          recipes.push(recipe);
        } catch (cause) {
          problems.push({ path: resolve(file), message: message(cause) });
        }
      }
    } catch (cause) {
      problems.push({ path: resolve(options.recipes), message: message(cause) });
    }
  }

  const guide: State["guide"] = { instructions: null, prompts: [] };
  if (options.guide) {
    try {
      const read = await readSchema(options.guide, Guide);
      guide.instructions = read.instructions?.trim() || null;
      for (const prompt of read.prompts) {
        // A recipe's slash command has the recipe's name; the registry rejects the clash on save.
        if (recipes.some((r) => r.name === prompt.name)) problems.push({ path: resolve(options.guide), message: `prompt "${prompt.name}" has a recipe's name; skipped` });
        else guide.prompts.push(prompt);
      }
    } catch (cause) {
      problems.push({ path: resolve(options.guide), message: message(cause) });
    }
  }

  return { components, theme, recipes, guide, problems };
}

/** Describes what changed between two loads, plus problems that are new. */
function describe(before: State, after: State): string[] {
  const lines: string[] = [];
  for (const c of after.components) {
    const old = before.components.find((b) => b.manifest.name === c.manifest.name);
    if (!old) lines.push(`${c.manifest.name}@${c.manifest.version} added (${c.hash})`);
    else if (old.hash !== c.hash || JSON.stringify(old.manifest) !== JSON.stringify(c.manifest)) lines.push(`${c.manifest.name}@${c.manifest.version} reloaded (${c.hash})`);
  }
  for (const b of before.components) if (!after.components.some((c) => c.manifest.name === b.manifest.name)) lines.push(`${b.manifest.name} removed`);
  if (JSON.stringify(before.theme) !== JSON.stringify(after.theme)) lines.push("theme reloaded");
  if (JSON.stringify(before.recipes) !== JSON.stringify(after.recipes)) lines.push(`recipes reloaded (${after.recipes.map((r) => r.name).join(", ") || "none"})`);
  if (JSON.stringify(before.guide) !== JSON.stringify(after.guide)) lines.push("guide reloaded");
  for (const p of after.problems) {
    if (!before.problems.some((b) => b.path === p.path && b.message === p.message)) lines.push(`problem: ${p.message}`);
  }
  return lines;
}

/**
 * Components, theme, recipes and guide read from files, for `genui serve`. A file that doesn't load
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
        recipes: state.recipes,
        instructions: state.guide.instructions,
        prompts: state.guide.prompts,
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
    instructions: () => state.guide.instructions ?? undefined,
  };
}
