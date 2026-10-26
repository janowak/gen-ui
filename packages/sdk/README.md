# @genui/sdk

Put genui's forms, charts, recipes and your components on your own MCP server, next to your tools. Views call your tools through the host, so your data never goes through genui.

```ts
import { connectGenUI, mountGenUI } from "@genui/sdk";

const genui = connectGenUI({ url: process.env.GENUI_MCP_URL, token: process.env.GENUI_MCP_TOKEN });
await mountGenUI(server, { genui, watch: true });
```

`GENUI_MCP_URL` is your workspace's MCP address; `GENUI_MCP_TOKEN` is a server token from the genui connector (Workspace → Tokens).

See [app-mcp.com](https://app-mcp.com).
