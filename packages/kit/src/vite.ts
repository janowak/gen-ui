import { relative, resolve } from "node:path";
import { MAX_BUNDLE_BYTES } from "@genui/format";
import type { Logger, Plugin, PluginOption } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { devPlugin } from "./dev/plugin.js";
import { DEFAULT_COMPONENT, loadManifest } from "./load.js";

export interface GenUIPluginOptions {
  /** Module whose default export is `defineComponent(...)`. Default `src/component.ts`. Must not touch the DOM. */
  component?: string;
  /** Warn above this bundle size, in KB. Default 500. The registry rejects bundles above 1.9 MB. */
  budgetKb?: number;
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/**
 * Builds a genui component: one self-contained HTML file (JS, CSS and assets inlined, as MCP Apps
 * hosts require) plus `genui.component.json` generated from the component definition, both in
 * the output directory, ready for `genui publish`.
 *
 * In dev (`vite` or `genui dev`), serves a local MCP Apps host at `/` that renders the component
 * with a props form, theme controls and mock tools, and reloads it when files change.
 */
export function genui(options: GenUIPluginOptions = {}): PluginOption[] {
  const budget = (options.budgetKb ?? 500) * 1024;
  let root = process.cwd();
  let outDir = "dist";
  let logger: Logger | undefined;
  let summary: string | undefined;

  const plugin: Plugin = {
    name: "genui",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      outDir = relative(root, resolve(root, config.build.outDir)) || ".";
      logger = config.logger;
    },
    generateBundle: {
      // After vite-plugin-singlefile's generateBundle (also order "post", listed first) has inlined everything.
      order: "post",
      async handler(_, bundle) {
        const pages = Object.values(bundle).filter((file) => file.fileName.endsWith(".html"));
        const page = pages[0];
        if (pages.length !== 1 || !page || page.type !== "asset") {
          this.error(`genui: a component builds to exactly one HTML page, found ${pages.length}. Use a single index.html entry.`);
        }
        const leftovers = Object.keys(bundle).filter((name) => name !== page.fileName);
        if (leftovers.length) {
          this.error(
            `genui: not inlined into ${page.fileName}: ${leftovers.join(", ")}. MCP Apps hosts load one HTML file; import assets from code so Vite can inline them.`,
          );
        }

        const bytes = Buffer.byteLength(page.source);
        if (bytes > MAX_BUNDLE_BYTES) this.error(`genui: ${page.fileName} is ${kb(bytes)}; the registry accepts up to ${kb(MAX_BUNDLE_BYTES)}.`);
        if (bytes > budget) this.warn(`${page.fileName} is ${kb(bytes)}, over the ${kb(budget)} budget. Large bundles render slowly in chat.`);

        let manifest: Awaited<ReturnType<typeof loadManifest>>;
        try {
          manifest = await loadManifest(root, options.component);
        } catch (cause) {
          this.error(`genui: ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        this.emitFile({
          type: "asset",
          fileName: "genui.component.json",
          source: `${JSON.stringify({ ...manifest, bundle: page.fileName }, null, 2)}\n`,
        });
        summary = `genui: ${manifest.name}@${manifest.version} → ${outDir}/${page.fileName} (${kb(bytes)}) + ${outDir}/genui.component.json`;
      },
    },
    closeBundle() {
      if (summary) logger?.info(summary);
    },
  };

  return [viteSingleFile(), plugin, devPlugin({ component: options.component ?? DEFAULT_COMPONENT })];
}
