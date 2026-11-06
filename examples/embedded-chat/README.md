# Embedded chat starter

From the repository root:

1. `pnpm install && pnpm --filter @app-mcp/host build`
2. Set `CLOUDFLARE_ACCOUNT_ID`, `WORKERS_AI_API_TOKEN` and `EMBED_MCP_URL` in `.env.local`. For a protected MCP server add `EMBED_MCP_TOKEN`. These are server-only values.
3. Set `EMBED_MODEL_TOOLS` to a comma-separated list of model tools and `EMBED_APP_TOOLS` to the tools widgets may invoke. The default model list is `render_form,render_chart`; the widget list is empty.
4. `pnpm --filter @app-mcp/embedded-chat-example run server`
5. In another terminal: `pnpm --filter @app-mcp/embedded-chat-example dev`
6. Open http://localhost:4190 and ask for a form or chart.

The server listens on loopback port 4191; Vite proxies `/api`. The separate sandbox on 127.0.0.1:4192 receives no application cookies. Ports can be changed in `server.ts`, `vite.config.ts` and `src/main.tsx` together.

This is a local single-user starter. Before exposing it publicly, replace the environment token with a caller-scoped authenticated connection, validate request bodies, add rate limits, and store authoritative history and tool outcomes. See the host package README.
