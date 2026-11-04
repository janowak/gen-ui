# @app-mcp/sdk

Put app-mcp's forms, charts, your components and workflows on your own MCP server, next to your tools. Views call your tools through the host, so your data never goes through app-mcp.

```ts
import { connectAppMcp, mountAppMcp } from "@app-mcp/sdk";

const appMcp = connectAppMcp({ url: process.env.APP_MCP_MCP_URL, token: process.env.APP_MCP_MCP_TOKEN });
await mountAppMcp(server, { appMcp, watch: true });
```

`APP_MCP_MCP_URL` is your workspace's MCP address; `APP_MCP_MCP_TOKEN` is a server token from the app-mcp connector (Workspace → Tokens).

See [app-mcp.com](https://app-mcp.com).
