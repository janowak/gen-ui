# @app-mcp/cli

The `genui` command: start a component, try it locally, and publish it to your genui workspace.

```bash
npx @app-mcp/cli init my_poll      # a new component, ready to run
cd my_poll && npm install
npm run dev                      # props form, theme and mock tools in a local host
npx genui serve                  # a local MCP with it: http://localhost:4100/mcp
GENUI_TOKEN=<publish token> npx genui publish
```

Create the publish token in the genui connector (`https://api.app-mcp.com/mcp`), under Workspace → Tokens. Commands that change a workspace need a token; `GENUI_URL` points at a self-hosted registry (default `https://api.app-mcp.com`). `genui --help` lists every command.

See [app-mcp.com](https://app-mcp.com).
