import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * /llms.txt is the setup guide AI coding agents follow: the same file `app-mcp guide` prints, read from
 * the CLI package so the two never differ.
 */
function llmsTxt(): Plugin {
  const guide = () => readFileSync(new URL("../../packages/cli/guide.md", import.meta.url), "utf8");
  return {
    name: "app-mcp-llms-txt",
    configureServer(server) {
      server.middlewares.use("/llms.txt", (_req, res) => {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(guide());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "llms.txt", source: guide() });
    },
  };
}

/**
 * /wrapped/ is the public share page for AI Wrapped: the component's own single-file bundle, which renders
 * the cards from the link's fragment when opened outside a chat (examples/wrapped/src/main.ts).
 */
function wrappedSharePage(): Plugin {
  const page = () => readFileSync(new URL("../../examples/wrapped/dist/index.html", import.meta.url), "utf8");
  return {
    name: "app-mcp-wrapped",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split(/[?#]/)[0] !== "/wrapped/") return next();
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "wrapped/index.html", source: page() });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), llmsTxt(), wrappedSharePage()],
  build: {
    // 404.html is served by Cloudflare for unknown paths (assets.not_found_handling in wrangler.jsonc)
    rolldownOptions: { input: ["index.html", "404.html", "roast.html"] },
  },
});
