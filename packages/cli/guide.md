# Setting up app-mcp: a guide for AI coding agents

You are setting app-mcp up for the person you work with. app-mcp shows interactive views (forms, charts and the company's own components) inside AI chats such as Claude and ChatGPT, through an MCP connector. This guide matches the `app-mcp` CLI that printed it. Run every command as `npx @app-mcp/cli <command>`, or `npx app-mcp <command>` in a project that has `@app-mcp/cli` installed.

Work through the steps in order. Stop and ask the person only where a step says so.

## What you are building

- **A workspace** in app-mcp holds components, a theme, instructions and workflows. It has environments; `prod` always exists.
- **The end-user MCP** is the connector the company's customers add to their chat. It offers `render_form`, `render_chart` and one `render_<name>` tool per published component.
- **A component** is a small web view (TypeScript, any framework) with typed props. The model calls `render_<name>` with those props and the view appears in the chat.
- **A workflow** is a playbook in plain words that tells the model when and how to use the tools and components.

## 1. Sign in

Check first:

```bash
npx @app-mcp/cli whoami
```

If it says you are not signed in, run:

```bash
npx @app-mcp/cli login
```

This opens the browser and waits up to five minutes. Tell the person: "Click Allow in the browser tab that just opened." They may need to sign in or create an account there first. Never ask them to paste a token into the chat. If the browser can't open (a remote machine), give them the URL the command prints.

Login signs the person in, not a workspace: the CLI reaches every workspace they're in. If `whoami` lists several and says none is picked, or the person wants another, ask which one and run `npx @app-mcp/cli use <workspace>` (its address, e.g. `acme`, from `npx @app-mcp/cli workspaces`). Publishing and changing settings need the person to be an admin of that workspace.

`whoami` and `login` both print two addresses. Keep them for the last step:

- **Manage it**: where admins manage the workspace, in a browser or as a connector.
- **Your users add**: the end-user MCP.

In CI there is no browser: set `APP_MCP_TOKEN` to a publish token (`npx @app-mcp/cli token publish ci`). A self-hosted registry is selected with `APP_MCP_URL`.

## 2. Pick the path

Look at the project and decide. If you can't tell, ask the person one question: "Do you already have an MCP server your customers connect to?"

- **No MCP server.** Use the hosted end-user MCP as it is. Views can show things and send the user's answers back to the conversation, but they can't call the company's own tools. Go to step 3.
- **An MCP server exists** (TypeScript on `@modelcontextprotocol/server` 2.3+, or Python on `mcp` 2.3+). Do step 3, then step 5 to put app-mcp's tools on that server so views can call its tools. The company's data never passes through app-mcp.

## 3. Create a component

Ask what the component should show if the person hasn't said. Name it in lowercase with underscores (`order_status`). Put it in its own directory, which must be empty or missing:

```bash
npx @app-mcp/cli init components/order_status
```

```bash
cd components/order_status && npm install
```

Then read `AGENTS.md` in that directory: it explains the files, the render context and how to check your work. In short, `src/component.ts` is what the model sees (name, description, props as a Zod schema, and the `tools` it calls), and `src/main.ts` renders it.

Write the `description` and each prop's `.describe()` for the model: say when to use the component and what each prop means. That text is the tool definition.

Check it before publishing:

```bash
npm run build
```

The build type-checks, validates the component and writes `dist/`. Fix every error. You can't see the view yourself, so tell the person they can look at it with `npm run dev`, which opens a local host with a props form, a theme and mock tools.

## 4. Publish

```bash
npm run app-mcp:publish
```

This builds and publishes to `prod`. The registry numbers the versions. The end-user MCP now offers `render_<name>`. Publish to another environment with `--env <name>` after `npx @app-mcp/cli env add <name>`. `npx @app-mcp/cli list` shows what each environment serves.

## 5. Connect an existing MCP server (only on that path)

Create a server token and note the end-user MCP address (`whoami` prints it):

```bash
npx @app-mcp/cli token server my-server
```

The token is printed once. Put it in the project's secret store or its local env file as `APP_MCP_MCP_TOKEN`, with the end-user MCP address as `APP_MCP_MCP_URL`. Don't commit it and don't repeat it in the chat.

TypeScript (`npm install @app-mcp/sdk`):

```ts
import { connectAppMcp, mountAppMcp } from "@app-mcp/sdk";

// Once per process.
const appMcp = connectAppMcp({ url: process.env.APP_MCP_MCP_URL, token: process.env.APP_MCP_MCP_TOKEN });

// Per server instance, next to the server's own tools.
await mountAppMcp(server, { appMcp, watch: true });
```

Python (`pip install app-mcp-sdk`):

```python
from app_mcp import connect_app_mcp, mount_app_mcp

app_mcp = connect_app_mcp(url=os.environ["APP_MCP_MCP_URL"], token=os.environ["APP_MCP_MCP_TOKEN"])
mount_app_mcp(server, app_mcp)
```

Views call the server's own tools by name. A tool a form submits to returns `{ ok: true, message? }` or `{ ok: false, fieldErrors?, formError? }` in its structured content. A component lists the tools it calls in `tools: [...]` in `src/component.ts`.

On this path the customers' connector is the company's own MCP server, not the hosted address.

## 6. Tell the model how to use it (optional, usually worth it)

**Instructions** say what the connector helps with, in a few sentences (up to 4000 characters):

```bash
npx @app-mcp/cli instructions instructions.md
```

**Workflows** are playbooks. Put `<name>.workflow.md` in the component directory or its `workflows/`; `publish` sends them with the component:

```md
---
title: Order status
description: The user asks where an order is.
---
1. Find the order with search_orders.
2. Show it with render_order_status.
```

Without `params` a workflow is part of the instructions the model always has; keep those short, since instructions and such workflows share a 50000 character limit. With `params` it becomes a slash command the user starts:

```md
params:
  - name: order
    description: Order number, if you know it
```

## 7. Hand over

Finish by telling the person, in a few lines:

1. What you created and published (component names, environment).
2. The **admin link** ("Manage it"), where they change the theme, instructions, workflows, people and tokens.
3. The **user link** ("Your users add"), or their own server's address on the existing-server path, and how to try it: in Claude, Settings → Connectors → Add custom connector, paste the address, then ask for the component in a chat. Custom connectors need a paid Claude plan or ChatGPT's developer mode.
4. Anything you could not check, such as how the view looks.

## Reference

- `npx @app-mcp/cli --help` lists every command. `--json` on `whoami`, `list`, `env list` and `publish` prints machine-readable output.
- `npx @app-mcp/cli serve` in a component directory runs a local end-user MCP at `http://localhost:4100/mcp` with no account, rebuilt on save.
- Theme: a JSON file set with `npx @app-mcp/cli theme theme.json`. Components get it as CSS variables (`--app-mcp-primary`, `--app-mcp-accent`, `--app-mcp-radius`).
- An environment serves exactly what was last published to it. To go back, publish the older version again: `npx @app-mcp/cli publish <name>@<version>`.
- `npx @app-mcp/cli logout` signs out and revokes the token.
