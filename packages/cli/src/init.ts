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
        dev: "app-mcp dev .",
        build: "tsc --noEmit && vite build",
        serve: "app-mcp serve .",
        "app-mcp:publish": "npm run build && app-mcp publish .",
      },
      dependencies: { "@app-mcp/kit": `^${version}` },
      devDependencies: { "@app-mcp/cli": `^${version}`, typescript: "^5.9.3", vite: "^8.3.5" },
    },
    null,
    2,
  )}\n`,
  "vite.config.ts": `import { appMcp } from "@app-mcp/kit/vite";
import { defineConfig } from "vite";

// Builds a single-file dist/index.html plus dist/app-mcp.component.json from src/component.ts.
export default defineConfig({ plugins: [appMcp()] });
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
      /* Host colors and fonts arrive as CSS variables; --app-mcp-* come from your workspace theme. */
      :root { color-scheme: light dark; }
      html, body { margin: 0; background: transparent; font-family: var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, #141413); }
      .card { margin: 1px; padding: 16px; border-radius: 12px; border: 1px solid var(--color-border-primary, #e5e5e5); background: var(--color-background-primary, #fff); }
      h1 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
      .options { display: flex; flex-wrap: wrap; gap: 8px; }
      button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; cursor: pointer; border: 1px solid var(--color-border-primary, #d4d4d4); background: transparent; color: inherit; }
      button[aria-pressed="true"] { background: var(--app-mcp-primary, #2563eb); border-color: transparent; color: #fff; }
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
  "src/component.ts": `import { defineComponent, z } from "@app-mcp/kit";

// What the model sees: the tool render_${name}, its description and its props.
export default defineComponent({
  name: "${name}",
  title: "Quick choice",
  description: "Ask the user to pick one of a few options inside the chat. Use it when a question has a short list of answers.",
  props: z.object({
    question: z.string().describe("The question to ask."),
    options: z.array(z.string()).min(2).max(6).describe("The answers to choose from."),
  }),
});
`,
  "src/main.ts": `import { mount, type ContextOf } from "@app-mcp/kit";
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

A app-mcp component, built with [@app-mcp/kit](https://www.npmjs.com/package/@app-mcp/kit).

\`\`\`bash
npm install
npm run dev        # props form, theme and mock tools in a local host
npm run serve      # a local MCP with this component: http://localhost:4100/mcp
\`\`\`

Publish it to your workspace. Sign in once through the browser, then publish:

\`\`\`bash
npx app-mcp login
npm run app-mcp:publish
\`\`\`

In CI, set \`APP_MCP_TOKEN\` to a publish token instead (\`npx app-mcp token publish ci\`).

Your workspace's MCP then offers \`render_${name}\`. The registry versions it: a changed build gets the next patch, an unchanged one is a no-op. To manage versions yourself, set \`version\` in \`src/component.ts\`.

Working with an AI coding agent? It reads \`AGENTS.md\`.
`,
  "AGENTS.md": `# ${name}: an app-mcp component

This directory is one app-mcp component: a small web view that an AI chat (Claude, ChatGPT) shows when the model calls the tool \`render_${name}\`. For setting up a whole project (sign-in, connecting an MCP server, workflows), run \`npx app-mcp guide\` and follow it.

## Files

- \`src/component.ts\`: what the model sees. \`name\`, \`title\`, \`description\` (when to use it), \`props\` (a Zod schema; each \`.describe()\` is read by the model) and optionally \`tools: ["tool_name"]\`, the company's MCP tools the view calls.
- \`src/main.ts\`: \`mount(component, render)\`. \`render(ctx)\` runs on every change.
- \`index.html\`: the markup and styles. Everything is built into one HTML file; don't load scripts, styles or fonts from other hosts.

## The render context

- \`ctx.status\`: \`waiting\`, \`streaming\`, \`ready\`, \`error\` or \`cancelled\`. Render something for each; props are complete only when \`ready\`.
- \`ctx.props\`: the validated props once ready. \`ctx.partial\`: incomplete props while the model is still writing them, for a preview.
- \`ctx.tools.call(name, args)\`: calls a declared tool on the company's server and returns \`{ ok, data }\`. It returns \`{ ok: false, unavailable: true }\` where there are no data tools (the hosted connector, registry previews), so handle that.
- \`ctx.model.send(text)\`: posts a message as the user. \`ctx.model.update(text)\`: adds context for the model's next turn.
- \`ctx.useState(initial)\`: state kept per rendered message, as \`[value, setValue, { restored }]\`. Wait for \`restored\` before acting on it.
- Host colors and fonts arrive as CSS variables (\`--color-*\`, \`--font-*\`), the workspace theme as \`--app-mcp-primary\`, \`--app-mcp-accent\` and \`--app-mcp-radius\`. Use them with fallbacks so the view matches the chat in light and dark.
- React: use \`useViewState\` from \`@app-mcp/kit/react\` for the same saved state.

## Check your work

\`\`\`bash
npm run build   # type-checks, validates the component, writes dist/
\`\`\`

Fix every error before publishing. You can't see the view from a terminal: tell the person to run \`npm run dev\`, which opens a local host with a props form, theme and mock tools. \`npm run serve\` runs a local MCP with the component at http://localhost:4100/mcp.

## Publish

\`\`\`bash
npx app-mcp whoami        # signed in? if not: npx app-mcp login (the person clicks Allow in the browser)
npm run app-mcp:publish   # builds and publishes to prod; --env <name> for another environment
\`\`\`

Never ask the person to paste a token into the chat. Workflows (playbooks for the model) go next to the component as \`<name>.workflow.md\` and are published with it.
`,
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Writes a new component into `dir`, which must be missing or empty. Returns the component's name. */
export async function init(dir: string, name = componentName(dir)): Promise<string> {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name))
    throw new Error(`--name must be lowercase letters, digits and _, starting with a letter (got "${name}")`);
  const root = resolve(dir);
  if ((await exists(root)) && (await readdir(root)).length > 0) throw new Error(`${root} isn't empty`);
  for (const [file, content] of Object.entries(files(name))) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return name;
}
