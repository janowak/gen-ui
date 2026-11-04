# @app-mcp/kit

Build components for MCP Apps hosts (Claude, ChatGPT, …) and publish them with genui. Describe the component once with `defineComponent`: props are a Zod schema, validated in the view and published as the tool's input schema. `mount` wires it to the host: props as the model streams them, host styles and your theme, per-render state, and tool calls.

```ts
import { defineComponent, z } from "@app-mcp/kit";

export default defineComponent({
  name: "my_poll",
  version: "0.1.0",
  description: "Ask the user to pick one of a few options.",
  props: z.object({ question: z.string(), options: z.array(z.string()) }),
});
```

The `genui()` Vite plugin (`@app-mcp/kit/vite`) builds a single-file `dist/index.html` and `dist/genui.component.json`. Start a component with `npx @app-mcp/cli init`.

See [app-mcp.com](https://app-mcp.com).
