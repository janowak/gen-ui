# app-mcp

- pnpm monorepo. Packages export from `dist/`, so run `pnpm build` before starting anything; `pnpm test` runs every suite.
- **In a linked worktree** (under `.claude/worktrees/`, or wherever `git rev-parse --git-dir` differs from `--git-common-dir`): run `pnpm dev:setup` before starting any service, then follow the `worktree` skill. It gives the worktree its own ports, registry and tokens; without it, services collide with the main checkout's.
- Deploy with `pnpm deploy:registry` / `pnpm deploy:site` whenever a change is ready; wrangler `--remote` is fine too. Deploy from the main checkout on `master`, not from a linked worktree, so what ships is what's merged.
