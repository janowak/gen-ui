# @app-mcp/cli

The `app-mcp` command: start a component, try it locally, and publish it to your app-mcp workspace.

```bash
npx @app-mcp/cli init my_poll      # a new component, ready to run
cd my_poll && npm install
npm run dev                      # props form, theme and mock tools in a local host
npx app-mcp serve                  # a local MCP with it: http://localhost:4100/mcp
APP_MCP_TOKEN=<publish token> npx app-mcp publish
```

Create the publish token in the app-mcp connector (`https://api.app-mcp.com/mcp`), under Workspace → Tokens. Commands that change a workspace need a token; `APP_MCP_URL` points at a self-hosted registry (default `https://api.app-mcp.com`). `app-mcp --help` lists every command.

See [app-mcp.com](https://app-mcp.com).
