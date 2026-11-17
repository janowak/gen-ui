import { z } from "zod";
import { Theme } from "./theme.js";
import type { Workflow } from "./workflow.js";

/** Every workspace has it, and the end-user MCP serves it at `/w/<workspace>/mcp`. Admins add the others. */
export const DEFAULT_ENVIRONMENT = "prod";

/**
 * Outside prod, tool names end in `_<environment>`. Fifteen characters keep
 * `render_<component>_<environment>` within the 64 characters some hosts allow.
 */
export const EnvironmentName = z.string().regex(/^[a-z][a-z0-9]{0,14}$/, "lowercase letters and digits, up to 15 characters");

/** A workspace's handle in its end-user MCP address, `/w/<slug>/mcp`. Unique across the registry. */
export const WorkspaceSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single dashes")
  .max(40, "up to 40 characters");

/** A valid slug from a workspace name: "Acme Support" → "acme-support". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ'’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

/** Built-in components own render_form / render_chart. */
export const RESERVED_NAMES = ["form", "chart"];

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Exact external HTTP(S) origins required by a view. */
const Origin = z.url({ protocol: /^https?$/ }).regex(/^https?:\/\/[^/?#@*]+$/, "Use an exact origin");
export const ComponentCsp = z.object({
  resourceDomains: z.array(Origin).max(30).optional(),
  connectDomains: z.array(Origin).max(30).optional(),
});
export type ComponentCsp = z.infer<typeof ComponentCsp>;
export function componentMetadata(csp?: ComponentCsp, metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!csp) return metadata;
  const ui = (metadata?.ui ?? {}) as Record<string, unknown>;
  const base = (ui.csp ?? {}) as ComponentCsp;
  const merged = { ...base };
  for (const key of ["resourceDomains", "connectDomains"] as const) {
    if (base[key] || csp[key]) merged[key] = [...new Set([...(base[key] ?? []), ...(csp[key] ?? [])])];
  }
  return { ...metadata, ui: { ...ui, csp: merged } };
}

/** `app-mcp.component.json`: published next to the single-file HTML bundle. */
export const ComponentManifest = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase letters, digits and _; becomes the tool render_<name>")
    .refine((name) => !RESERVED_NAMES.includes(name), "reserved for a built-in component"),
  version: z.string().regex(SEMVER, "x.y.z"),
  title: z.string().optional(),
  description: z.string().min(1).describe("Tool description the model reads to decide when to use the component."),
  props: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema (type: object) of the props the model passes. Becomes the tool's input schema."),
  csp: ComponentCsp.optional(),
  tools: z.array(z.string()).default([]).describe("Tools on the host MCP server the component calls."),
  contract: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Component contract version the bundle was built against (set by @app-mcp/kit). Absent for hand-built bundles."),
});
export type ComponentManifest = z.infer<typeof ComponentManifest>;

/**
 * What a publisher sends. Without `version` the registry assigns one: the published version whose bundle
 * and manifest match, else the next patch after the newest. Versions stay immutable either way.
 */
export const PublishManifest = ComponentManifest.extend({ version: ComponentManifest.shape.version.optional() });
export type PublishManifest = z.infer<typeof PublishManifest>;

/** The version a component without one shows as when served locally (`app-mcp dev`). */
export const LOCAL_VERSION = "0.0.0";

export interface CatalogComponent {
  name: string;
  version: string;
  /** Content hash of the bundle; part of its `ui://app-mcp/c/<name>/<hash>` URI. */
  hash: string;
  manifest: ComponentManifest;
}

/** What one environment serves: its components, theme, instructions and workflows. */
export interface Catalog {
  environment: string;
  theme: Theme | null;
  components: CatalogComponent[];
  /** The environment's own instructions; `serverInstructions` adds the workflows. */
  instructions: string | null;
  workflows: Workflow[];
  /** Whether the end-user MCP offers the built-in render_form and render_chart. Default true. */
  builtIns?: boolean;
}

/** Max bundle size accepted by the registry. D1 stores at most 2 MB per row; the rest is room for the manifest. */
export const MAX_BUNDLE_BYTES = 1_900_000;

/** Build/publish budget before the registry extracts immutable JS/CSS. */
export const MAX_PUBLISH_BYTES = 25_000_000;
