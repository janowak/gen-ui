import { z } from "zod";
import { Theme } from "./theme.js";

export const CHANNELS = ["beta", "stable"] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

/** Built-in components own render_form / render_chart. */
export const RESERVED_NAMES = ["form", "chart"];

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `genui.component.json`: published next to the single-file HTML bundle. */
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
  tools: z.array(z.string()).default([]).describe("Tools on the host MCP server the component calls."),
});
export type ComponentManifest = z.infer<typeof ComponentManifest>;

export interface CatalogComponent {
  name: string;
  version: string;
  /** Content hash of the bundle; fetch it from /v1/bundles/:hash. */
  hash: string;
  manifest: ComponentManifest;
}

/** What the SDK pulls from the registry for one channel. */
export interface Catalog {
  channel: Channel;
  theme: Theme | null;
  components: CatalogComponent[];
}

/** Max bundle size accepted by the registry. */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
