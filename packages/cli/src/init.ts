import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

/** The kit and CLI versions a new component starts on: the ones this CLI was released with. */
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** A component name from a directory name: lowercase letters, digits and _, starting with a letter. */
export function componentName(dir: string): string {
  const name = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "");
  return name.length >= 2 ? name.slice(0, 41) : "my_component";
}

const files = (name: string): Record<string, string> => ({
  "package.json": `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "genui dev .",
        build: "tsc --noEmit && vite build",
        serve: "genui serve .",
        "genui:publish": "npm run build && genui publish .",
      },
      dependencies: { "@genui/kit": `^${version}` },
      devDependencies: { "@genui/cli": `^${version}`, typescript: "^5.9.3", vite: "^8.3.5" },
    },
    null,
    2,
  )}\n`,
  "vite.config.ts": `import { genui } from "@genui/kit/vite";
import { defineConfig } from "vite";

// Builds a single-file dist/index.html plus dist/genui.component.json from src/component.ts.
export default defineConfig({ plugins: [genui()] });
`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        types: ["vite/client"],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
  ".gitignore": "node_modules\ndist\n",
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${name}</title>
    <style>
      /* Host colors and fonts arrive as CSS variables; --genui-* come from your workspace theme. */
      :root { color-scheme: light dark; }
      html, body { margin: 0; background: transparent; font-family: var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, #141413); }
      .card { margin: 1px; padding: 16px; border-radius: 12px; border: 1px solid var(--color-border-primary, #e5e5e5); background: var(--color-background-primary, #fff); }
      h1 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
      .options { display: flex; flex-wrap: wrap; gap: 8px; }
      button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; cursor: pointer; border: 1px solid var(--color-border-primary, #d4d4d4); background: transparent; color: inherit; }
      button[aria-pressed="true"] { background: var(--genui-primary, #2563eb); border-color: transparent; color: #fff; }
      button:disabled { cursor: default; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 id="question">…</h1>
      <div class="options" id="options"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  "src/component.ts": `import { defineComponent, z } from "@genui/kit";

// What the model sees: the tool render_${name}, its description and its props.
export default defineComponent({
  name: "${name}",
  version: "0.1.0",
  title: "Quick choice",
  description: "Ask the user to pick one of a few options inside the chat. Use it when a question has a short list of answers.",
  props: z.object({
    question: z.string().describe("The question to ask."),
    options: z.array(z.string()).min(2).max(6).describe("The answers to choose from."),
  }),
});
`,
  "src/main.ts": `import { mount, type ContextOf } from "@genui/kit";
import component from "./component";

const questionEl = document.getElementById("question")!;
const optionsEl = document.getElementById("options")!;

// Called on every change: props streaming in, theme, saved state.
function render(ctx: ContextOf<typeof component>) {
  questionEl.textContent = ctx.props?.question ?? ctx.partial?.question ?? "…";
  if (ctx.status === "error") {
    optionsEl.textContent = ctx.error ?? "Something went wrong.";
    return;
  }
  // Kept per render, so the answer stays when the host shows this message again.
  const [picked, setPicked, state] = ctx.useState<string | undefined>(undefined);
  const options = ctx.props?.options ?? [];
  optionsEl.replaceChildren(
    ...options.map((option) => {
      const button = document.createElement("button");
      button.textContent = option;
      button.setAttribute("aria-pressed", String(option === picked));
      button.disabled = ctx.status !== "ready" || !state.restored || picked !== undefined;
      button.onclick = async () => {
        setPicked(option);
        // Sends the answer to the conversation as the user's message.
        await ctx.model.send(option);
      };
      return button;
    }),
  );
}

mount(component, render);
`,
  "README.md": `# ${name}

A genui component, built with [@genui/kit](https://www.npmjs.com/package/@genui/kit).

\`\`\`bash
npm install
npm run dev        # props form, theme and mock tools in a local host
npm run serve      # a local MCP with this component: http://localhost:4100/mcp
\`\`\`

Publish it to your workspace with a publish token (Workspace → Tokens in the genui connector):

\`\`\`bash
GENUI_TOKEN=<publish token> npm run genui:publish
\`\`\`

Your workspace's MCP then offers \`render_${name}\`. Bump \`version\` in \`src/component.ts\` for every publish.
`,
});

const exists = (path: string) => access(path).then(() => true, () => false);

/** Writes a new component into `dir`, which must be missing or empty. Returns the component's name. */
export async function init(dir: string, name = componentName(dir)): Promise<string> {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new Error(`--name must be lowercase letters, digits and _, starting with a letter (got "${name}")`);
  const root = resolve(dir);
  if ((await exists(root)) && (await readdir(root)).length > 0) throw new Error(`${root} isn't empty`);
  for (const [file, content] of Object.entries(files(name))) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return name;
}
