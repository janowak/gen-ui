# Plugin plan

Ship app-mcp as an official plugin for coding agents. A plugin bundles a skill (how to build and publish components) with our admin MCP (the workspace), and installs with one command. After a single sign-in, every agent session knows the project uses app-mcp and can build, publish and manage without a pasted prompt.

**Status (2026-11-15)**
- Proposed. The admin MCP, OAuth, workspace creation and CLI sign-in all exist. The new work is mostly packaging (§4), plus agent-facing text on the admin MCP (§5) and the site (§6).
- Replaces the "one prompt" Get started as the main path. The prompt stays as the fallback for agents with no plugin support.

---

## 1. Why a plugin

How agent tools distribute in 2026:

- **Plugin = skill + MCP.** Claude Code's marketplace (April 2026) installs a plugin's skills and MCP servers together, with no separate `claude mcp add`. Codex plugins (March 2026) work the same way: an OpenAI-run directory, plus marketplaces for a repo or a single user. Other agents use universal installers (`npx plugins add`, `npx skills add`).
- **SaaS ships a remote MCP with OAuth**, not a token pasted into config. Supabase is in Anthropic's official marketplace. Vercel and Stripe ship plugins or skills with their CLI underneath.
- **The CLI stays** for CI and for anything that touches local files.

Our admin MCP at `https://api.app-mcp.com/mcp` already fits: it's remote, uses OAuth 2.1 with discovery, dynamic registration and CIMD, and the same server shows views in Claude and ChatGPT and plain tools in a coding agent. One MCP serves both places.

## 2. What we ship

| Piece | Job | Status |
|---|---|---|
| Admin MCP `/mcp` | Workspace, environments, theme, instructions, workflows, people, tokens | Exists |
| OAuth sign-in | The agent signs the person in; in hosted mode a first sign-in creates a personal workspace (`store.resolveMembership`) | Exists |
| `@app-mcp/cli` | `init`, `dev`, `serve`, `publish`, CI | Exists |
| `guide.md` | Setup steps for agents, matches the CLI version that prints it | Exists |
| **Plugin** | Thin skill + `.mcp.json` pointing to `/mcp` | New |
| **Marketplace repo** | Public repo that `/plugin marketplace add` and the Codex equivalent read | New |

## 3. The flow, step by step (Claude Code)

1. The admin installs the plugin (§6 shows the commands per agent).
2. On first use, Claude Code finds that the `app-mcp` server needs auth. The person runs `/mcp` (or the agent prompts them), the browser opens `/sign-in`, they choose Google or GitHub and click Allow on `/consent`. A new person gets a workspace.
3. The skill tells the agent to run `npx -y @app-mcp/cli guide` and follow it, so the steps always match the CLI version.
4. To publish, the agent runs `npx -y @app-mcp/cli login`. The browser already has the session from step 2, so it's one Allow click on `/cli` and no second sign-in. The token goes to `~/.config/app-mcp`.
5. The agent builds, checks and publishes with the CLI, and uses the admin MCP for the rest: theme, instructions, connector branding, links.
6. In later sessions, the skill and the MCP's instructions are already loaded, so "add a staging environment" or "publish my poll" work without setup.

## 4. Auth: one identity, two credentials

- **MCP OAuth token**, held by the agent host and bound to `/mcp`. Used for workspace management.
- **CLI admin token**, from `/cli`, in `~/.config/app-mcp`. Used for `publish` and the other CLI commands.

Both belong to the same better-auth user. Neither secret ever passes through the model, which matches how `token_create` already works: the admin clicks Reveal in the view, and "the secret never comes back to you".

**Rejected:**
- *An MCP tool that hands the agent a publish token.* Puts a secret in the transcript.
- *A `publish` tool that takes the bundle.* The single-file HTML would go through the model's context, which is slow and costly for anything but tiny components.
- *Accepting the CLI token on `/mcp` and writing it into agent configs.* A long-lived admin token in plain text in `~/.claude.json` and similar files.
- *A local stdio admin MCP in the CLI.* It works only in coding agents. The remote MCP also serves Claude and ChatGPT, and it's what marketplaces expect.

**Later, if two clicks feel like too many:** let `/cli` skip the Allow page for a short window right after an OAuth consent from the same session. That's an optional polish, not needed for launch.

## 5. Changes to the admin MCP

- **Text that stands alone.** Coding agents don't render views. Every tool result already returns text plus view state (`ok(text, state)`). Check that the text alone is enough for each tool. The ones to look at are the token tools ("click Reveal in the view": say where to click instead, i.e. the `/manage` link) and the icon upload (only possible in the view, so point to `/manage`).
- **Server instructions for coding agents:** one short paragraph saying components are built and published with `npx -y @app-mcp/cli` (see `guide`), while this MCP manages the workspace. Keep it under the instructions limit so it doesn't crowd the context.
- **A links tool or line in the instructions** giving the admin link and the end-user MCP, so the agent can finish with "here's what your users add", the same as `whoami`.

## 6. The plugin

**Repo:** a public `plugins` repo (name TBD, §9) with the marketplace catalog at its root. The monorepo keeps the source under `plugins/app-mcp/`, and a script copies it on release, so the plugin version follows the CLI release.

```
.claude-plugin/marketplace.json     the catalog: one entry, app-mcp
app-mcp/
  .claude-plugin/plugin.json        name, version, description, homepage
  .mcp.json                         { "app-mcp": { "type": "http", "url": "https://api.app-mcp.com/mcp" } }
  skills/app-mcp/SKILL.md           thin: when to use it, then "run npx -y @app-mcp/cli guide and follow it"
```

- Add the **Codex manifest** next to it. Check the current file layout against OpenAI's docs when building, since it has changed during 2026.
- **The skill stays thin on purpose.** The guide ships with the CLI and always matches the installed version. Copying it into the skill would drift.
- **Self-hosted registries:** the plugin points to cloud. Self-hosters add their own URL with `claude mcp add --transport http app-mcp https://<their-host>/mcp`. Document it in the guide.

**Site:** replace the hero's "Get started" link with a copy pill that has tabs per agent, as on comparable sites:

| Agent | Command |
|---|---|
| Claude Code | `/plugin marketplace add <org>/plugins`, then `/plugin install app-mcp@<marketplace>`; after the official listing, just `/plugin install app-mcp@claude-plugins-official` |
| Codex | its marketplace add/install, once the manifest is in |
| Others | `npx plugins add <org>/plugins` (check the installer's current syntax) |
| No plugins | today's copied prompt, now with `npx -y` |

The "No code yet? Try the built-in forms and charts" block stays as it is: that's the admin MCP in Claude and ChatGPT, where the views render.

## 7. Listings

1. **Our own marketplace repo:** works on day one, no review.
2. **Anthropic's official Claude Code marketplace:** submit after the flow has run end to end on cloud a few times.
3. **Codex's official directory:** self-serve publishing was "coming soon" as of May 2026. Check the status, and apply when it opens.
4. The connectors customers add are not listed: every workspace has its own URL. Each company lists its own connector if it wants to.

## 8. Order of work

1. §5: text-only check of the admin MCP's tools, plus the instructions paragraph and links. Test it with `claude mcp add --transport http app-mcp https://api-dev.app-mcp.com/mcp` from a clean machine profile.
2. §6: plugin source in `plugins/app-mcp/`, the release-copy script and the public marketplace repo.
3. Run the whole §3 flow with a brand-new Google account in Claude Code, then in Codex.
4. Site: the hero pill and the Get started section rewrite. `-y` in the copied prompt.
5. Submit the listings (§7).

**Done when:** a new person installs the plugin, signs in once, says "build me a poll and publish it", and ends with the admin link and the end-user MCP, without opening our docs or pasting a token.

## 9. Open questions

- **The name** (LANDING-DEPLOY-PLAN §8). The plugin name and marketplace entry should use the final product name, because renaming a listed plugin breaks installs.
- **The GitHub org and repo** for the public marketplace.
- **Cursor's plugin story:** check whether it has its own marketplace by now, or only installs MCP servers and rules.
- **OAuth in each agent:** check that Claude Code, Codex and Cursor all complete our OAuth flow (CIMD vs dynamic registration), and how each asks the person to sign in.
