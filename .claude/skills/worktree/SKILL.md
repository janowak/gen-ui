---
name: worktree
description: Work on and test app-mcp in an isolated git worktree with its own registry, ports and seeded data, so several agents can run the stack side by side. Use when asked to work in a worktree, to spin up agents that each change and test something, or when this session is in a linked worktree that has no .env.worktree yet.
---

# Work in a worktree

Each worktree runs its own stack: the registry on its own SQLite file, `app-mcp serve`, the demo, the playground and the site, on a block of ports no other checkout uses. No wrangler, no tunnel: everything is tested locally.

## Set it up

1. **Get into a worktree.** Already in one (under `.claude/worktrees/`)? Skip ahead. Otherwise use `EnterWorktree` with a short name for the task. For parallel agents, give each `isolation: "worktree"` and have it run step 2 itself.
2. **Run `pnpm dev:setup` from the worktree root.** It installs, builds, picks a free port slot, writes `.env.worktree` (ports, local URLs, tokens), points `.claude/launch.json` at those ports and seeds the registry: a workspace, a password user who manages it, and `examples/rating` and `examples/roast-my-github` with their workflows in prod. It prints the URLs. Re-running it is safe and keeps the slot and tokens.

`.env.local` is the main checkout's copy (Claude Code copies it in, via `.worktreeinclude`). Don't edit it; `.env.worktree` is loaded after it and wins.

## Run and test

- **Services:** start them by name from `.claude/launch.json` (`registry`, `serve`, `demo`, `playground`, `site`). They are on this worktree's ports, not 4000/4100/3001/5173/5180.
- **Demo → registry:** the demo uses this worktree's registry (`APP_MCP_MCP_URL`, `APP_MCP_MCP_TOKEN` in `.env.worktree`). Start the registry before the demo.
- **Playground:** open it with `?server=http://localhost:<demo port>/mcp`; setup prints the full URL.
- **Registry UI:** sign in with `APP_MCP_DEV_EMAIL` / `APP_MCP_DEV_PASSWORD` from `.env.worktree`, or `.env.local` when it sets them.
- **CLI:** `pnpm app-mcp <command>` loads both env files, so it talks to this worktree's registry with the seeded admin token. A bare `app-mcp` defaults to production: don't use it here.
- **Tests:** `pnpm test`. They use in-memory databases and random ports, and also run the registry on a local D1 (Miniflare), so wrangler isn't needed.

## Don't

- Deploy, or run wrangler against Cloudflare: the deploy scripts refuse to run in a worktree, and the project settings deny it.
- Start `wrangler dev` or a tunnel.
- Commit `.env.worktree` or the worktree's `.claude/launch.json` (setup hides it from git with `--skip-worktree`).

When you report back, say which slot and ports you used and what you ran.
