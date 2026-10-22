import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export type ViewName = "form" | "chart";

export interface ViewBundle {
  name: ViewName;
  html: string;
  /** Content hash; part of the `ui://` URI so hosts never serve a stale cached bundle. */
  hash: string;
  uri: string;
}

const require = createRequire(import.meta.url);

export function bundle(name: ViewName, html: string): ViewBundle {
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
  return { name, html, hash, uri: `ui://genui/${name}/${hash}` };
}

let builtIn: Promise<Record<ViewName, ViewBundle>> | undefined;

/** Loads the built-in view bundles shipped with @genui/ui (read and hashed once per process). */
export function loadBuiltInViews(): Promise<Record<ViewName, ViewBundle>> {
  builtIn ??= (async () => {
    const read = (name: ViewName) => readFile(require.resolve(`@genui/ui/views/${name}.html`), "utf8");
    const [form, chart] = await Promise.all([read("form"), read("chart")]);
    return { form: bundle("form", form), chart: bundle("chart", chart) };
  })();
  return builtIn;
}
