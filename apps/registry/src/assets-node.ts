import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { MANAGEMENT_VIEWS, type Assets } from "./views.js";

const require = createRequire(import.meta.url);

let loaded: Promise<Assets> | undefined;

/** Reads the views from @app-mcp/ui and the sign-in pages from dist-web/ (both built by `pnpm build`), once per process. */
export function loadAssets(): Promise<Assets> {
  loaded ??= (async () => {
    const view = (name: string) => readFile(require.resolve(`@app-mcp/ui/views/${name}.html`), "utf8");
    const page = (name: string) => readFile(new URL(`../dist-web/${name}.html`, import.meta.url), "utf8");
    const names = ["form", "chart", ...MANAGEMENT_VIEWS] as const;
    const [views, signIn, consent] = await Promise.all([Promise.all(names.map(view)), page("sign-in"), page("consent")]);
    return {
      views: Object.fromEntries(names.map((name, i) => [name, views[i]!])) as Assets["views"],
      pages: { "sign-in": signIn, consent },
    };
  })();
  return loaded;
}
