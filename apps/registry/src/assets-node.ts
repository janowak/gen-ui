import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Assets } from "./views.js";

const require = createRequire(import.meta.url);

let loaded: Promise<Assets> | undefined;

/** Reads the views from @genui/ui and the sign-in pages from dist-web/ (both built by `pnpm build`), once per process. */
export function loadAssets(): Promise<Assets> {
  loaded ??= (async () => {
    const view = (name: string) => readFile(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
    const page = (name: string) => readFile(new URL(`../dist-web/${name}.html`, import.meta.url), "utf8");
    const [form, chart, manager, theme, workflows, workspace, instructions, signIn, consent] = await Promise.all([
      view("form"),
      view("chart"),
      view("manager"),
      view("theme"),
      view("workflows"),
      view("workspace"),
      view("instructions"),
      page("sign-in"),
      page("consent"),
    ]);
    return { views: { form, chart, manager, theme, workflows, workspace, instructions }, pages: { "sign-in": signIn, consent } };
  })();
  return loaded;
}
