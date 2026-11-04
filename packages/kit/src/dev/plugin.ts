import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { loadManifest } from "../load.js";
import { harnessPage, VIEW_SHIM } from "./page.js";

/** The browser host (src/harness), bundled into dist/harness.js by `build:harness`. */
const HARNESS = fileURLToPath(new URL("../../dist/harness.js", import.meta.url));

/** Query parameter that serves the component itself; without it, `/` is the host page. */
export const VIEW_PARAM = "genui-view";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Dev server half of `genui()`: a local MCP Apps host at `/`, the component at `/?genui-view`,
 * its manifest at `/__genui/component.json`, and file changes pushed to the host page as
 * server-sent events so it can re-render the view with the same props.
 */
export function devPlugin(options: { component: string }): Plugin {
  let root = process.cwd();
  const clients = new Set<ServerResponse>();

  return {
    name: "genui:dev",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.httpServer?.once("close", () => clients.forEach((client) => client.end()));
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET") return next();
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (status: number, type: string, body: string) => {
          res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
          res.end(body);
        };

        switch (url.pathname) {
          case "/":
          case "/index.html":
            if (url.searchParams.has(VIEW_PARAM)) return next();
            return send(200, "text/html", harnessPage(VIEW_PARAM));
          case "/__genui/harness.js":
            try {
              return send(200, "text/javascript", await readFile(HARNESS, "utf8"));
            } catch {
              return send(
                500,
                "text/javascript",
                `document.body.textContent = "genui dev: ${HARNESS} is missing. Build @app-mcp/kit first.";`,
              );
            }
          case "/__genui/component.json":
            try {
              return send(200, "application/json", JSON.stringify(await loadManifest(root, options.component)));
            } catch (cause) {
              return send(500, "application/json", JSON.stringify({ error: message(cause) }));
            }
          case "/__genui/events":
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            res.write(": connected\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
          default:
            return next();
        }
      });
    },
    // The view (served by Vite as index.html) gets the host page's saved-state shim before its modules run.
    transformIndexHtml(_html, ctx) {
      if (!ctx.originalUrl?.includes(VIEW_PARAM)) return;
      return [{ tag: "script", children: VIEW_SHIM, injectTo: "head-prepend" }];
    },
    // The host page re-renders the view itself (fresh iframe, same props), so Vite's own HMR and
    // full reloads are off: they would reload the iframe behind the host's back and drop the session.
    handleHotUpdate({ file }) {
      const data = JSON.stringify({ file: relative(root, file) });
      for (const client of clients) client.write(`event: reload\ndata: ${data}\n\n`);
      return [];
    },
  };
}
