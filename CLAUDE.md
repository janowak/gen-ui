# genui

- pnpm monorepo. Packages export from `dist/`, so run `pnpm build` before starting anything; `pnpm test` runs every suite.
- **In a linked worktree** (under `.claude/worktrees/`, or wherever `git rev-parse --git-dir` differs from `--git-common-dir`): run `pnpm dev:setup` before starting any service, then follow the `worktree` skill. It gives the worktree its own ports, registry and tokens; without it, services collide with the main checkout's.
- Never deploy or run wrangler against Cloudflare (`--remote`, `wrangler deploy`, `pnpm deploy:*`): deploys are done by hand from the main checkout.
