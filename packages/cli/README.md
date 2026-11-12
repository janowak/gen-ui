# @app-mcp/cli

The `app-mcp` command: start a component, try it locally, and publish it to your app-mcp workspace.

```bash
npx @app-mcp/cli login             # sign in through the browser; nothing to copy
npx @app-mcp/cli init my_poll      # a new component, ready to run
cd my_poll && npm install
npm run dev                      # props form, theme and mock tools in a local host
npx app-mcp serve                  # a local MCP with it: http://localhost:4100/mcp
npx app-mcp publish                # publish it to your workspace
```

**With an AI coding agent:** ask it to run `npx @app-mcp/cli guide` and follow it. The guide covers sign-in, components, connecting your own MCP server, workflows, and ends with your admin link and the link your users add.

`login` keeps an admin token in `~/.config/app-mcp`; `whoami` shows the workspace and `logout` revokes the token. In CI, set `APP_MCP_TOKEN` to a publish token (`app-mcp token publish ci`). `APP_MCP_URL` points at a self-hosted registry (default `https://api.app-mcp.com`). `app-mcp --help` lists every command.

See [app-mcp.com](https://app-mcp.com).
