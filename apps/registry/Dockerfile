# The genui registry for self-hosting: Node 24 on SQLite, data in /data. genui cloud runs the same
# code on Cloudflare Workers and D1 (wrangler.jsonc). Build from the repository root:
#   docker build -f apps/registry/Dockerfile -t genui-registry .
# or use compose.yaml there.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# Only the registry and the workspace packages it depends on
RUN pnpm install --frozen-lockfile --filter "@app-mcp/registry..."
RUN pnpm --filter "@app-mcp/registry..." build
# The registry with its production dependencies, workspace packages included
RUN pnpm --filter @app-mcp/registry deploy --prod /out

FROM node:24-slim
ENV NODE_ENV=production PORT=4000 GENUI_DB=/data/genui.sqlite
WORKDIR /app
COPY --from=build /out .
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
