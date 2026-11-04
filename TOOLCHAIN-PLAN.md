# TypeScript 7, Vite 8 and Oxc plan (gen-ui and geogeo)

Make type-checking, building, linting and formatting faster in both repos, using the upstream tools directly:
- TypeScript 7 (the native `tsc`)
- Vite 8 with Rolldown
- Vitest 5
- Oxlint and Oxfmt in place of ESLint and Prettier. These are the linter and formatter Vite+ bundles.

Vite+ itself was tried on gen-ui and dropped (see "Why not Vite+"). All work happens on `master` in each repo, one commit per step, with no worktrees.

**Status (2026-10-26)**
- **gen-ui is done**, committed on `master` and not pushed:
  - `0fd73bd`: TypeScript 7 and the registry image fix
  - `79c2b71`, `44b1beb`, `bcd9e28`: Oxfmt and Oxlint settings, install and scripts
  - `88418f8`: the reformat
  - `227dcdd`: lint fixes and `.git-blame-ignore-revs`

- **geogeo is done** too, in 9 commits on its `master`, not pushed: `2788353` … `b3c3482`. See section 5.

  | gen-ui | TS 5.9 | Now |
  |---|---|---|
  | `pnpm build` | 10.3 s | 5.5–8.0 s ¹ |
  | `pnpm typecheck` | 6.5 s | 1.7–1.9 s |
  | `pnpm test` (185 tests pass) | 9.5 s | 9.4–11.9 s ² |
  | `pnpm check` (Oxfmt + Oxlint on the whole repo) | No lint or format | 0.5 s |
  | Registry image `node_modules` | 122 MB | 56 MB ³ |

  ¹ The range covers back-to-back runs on a busy machine.

  ² Vitest doesn't use `tsc`, so test time doesn't change.

  ³ The drop comes from `.pnpmfile.cjs` (Step 1), not from TS 7.

  Output compared with TS 5.9:
  - The emitted `.js` is byte-identical.
  - 4 `.d.ts` files contain the same lines in a different order (`stableTypeOrdering`): `format/chart`, `format/form`, `kit/load` and `registry/auth`.
  - In 16 source maps, only `mappings` changed.
  - `shadcn info` resolves the `@/` aliases exactly as before.
- **geogeo TS 7 dry run.** TS 7.0.2 was run from a scratch directory, and nothing was written to the repo.
  - Typecheck took 14.7 s on TS 5.9 and 3.3 s on TS 7.
  - The only TS 7 break is `baseUrl` in `packages/ui/tsconfig.json`.
  - Typecheck **already fails on TS 5.9**: 2 errors in `ui`, 25 in `map` and 7 in `app`. TS 7 reports the same failures. Step g1 fixes them.
- **Versions checked today:**
  - `typescript` 7.0.2 (7.1 is in beta)
  - `vite` 8.3.5, which needs Node `^20.19 || >=22.12`
  - `vitest` 5.0.5, which needs Node `^22.12 || ^24 || >=26`
  - `oxlint` 1.89.0, `oxfmt` 0.74.0 and `@oxlint/migrate` 1.89.0

**Principle: use each upstream tool directly.** Nothing that is published or deployed changes:
- `@app-mcp/kit` and `@app-mcp/cli` keep `vite` as a peer.
- `app-mcp init` still scaffolds plain Vite projects.
- Docker, Workers, Pages and the VPS run the same outputs as before.

## Why not Vite+

Vite+ 1.4 was tried as gen-ui Step 2, checked fully, and reverted. The step-1 lockfile was restored.
- **No speed gain.**
  - `vp run -r` builds, typechecks and tests in the same time as `pnpm -r`. The speed-up comes from TS 7.
  - Its task cache can't see the files the native TS 7 `tsc` reads or writes. That binary is Microsoft-signed with the hardened runtime, which most likely blocks the macOS file-access tracking.
  - After a source edit, a `tsc` task still got a cache hit, and a deleted `dist/` wasn't restored. So caching couldn't be used.
- **It replaces Vite.** A pnpm override points every `vite` in the workspace at VoidZero's `@voidzero-dev/vite-plus-core`.
  - The kit tests stop exercising the Vite that users install.
  - Vite upgrades follow Vite+ releases.
  - `vite-plus-core` ships no `vite` binary, so every script has to become `vp …`.
- **Cost:**
  - 54 more packages, and Node `^22.18 || ^24.11 || >=26`.
  - In place, `vp migrate` also reformats files, re-sorts `package.json` keys and replaces `tsx`.
  - Without a fix, the registry image grew to 196 MB.
- **What does pay off** is Oxlint and Oxfmt, and both install on their own.
- **Worth revisiting** if task caching starts to matter (a much bigger repo) and Vite Task can trace native binaries, or if one managed toolchain becomes a goal.

---

## 1. Today

| | gen-ui | geogeo |
|---|---|---|
| Package manager | pnpm 9.14.2 (pinned) | pnpm, not pinned. A stale `bun.lock` (Apr 17) sits next to `pnpm-lock.yaml`, and a `workspaces` field duplicates `pnpm-workspace.yaml` |
| Node | v25.2.1 in the shell (fnm). `node:24-slim` in Docker | `.nvmrc` 22.12.0, `.tool-versions` 24.11.1, v25.2.1 in the shell. Deploys build on the VPS (`remote-deploy.ts` → `deploy.ts` → `pnpm install` + `pnpm --filter X build`) |
| TypeScript | **7.0.2** at the root only (Step 1) | 5.9.3 pinned in each package |
| Vite / tests | Vite 8.3.5, Vitest 5.0.5 (17 test files) | Vite 7.3.1 (app, admin, landing) and Vite 6 (map). No tests |
| Lint / format | None | ESLint 9 with typescript-eslint, plus Prettier 3 with a custom `prettier-plugin-single-line-imports.mjs` |
| Library output | `tsc -p` for each package | n/a |
| Running tasks | `pnpm -r build/typecheck/test`, no caching | `pnpm -r typecheck` |
| Uses the TS JS API | Nothing | typescript-eslint. `@trpc/server` and `inngest` list `typescript` only as a types peer |

## 2. Target

| Concern | Command | Tool |
|---|---|---|
| Dev server and build | `vite`, `vite build` | Vite 8 (Rolldown, Oxc). gen-ui is there already, geogeo moves from 7 |
| Tests | `vitest run` | Vitest 5 (gen-ui) |
| Types | `tsc --noEmit` | TypeScript 7 |
| Lint | `oxlint` | Oxlint |
| Format | `oxfmt`, `oxfmt --check` | Oxfmt |
| Library output (gen-ui) | `tsc -p` | TypeScript 7 |
| Workspace tasks | `pnpm -r …` | Unchanged, with no task caching |

## 3. Decisions (recommendation first)

1. **Type gate: `tsc` 7.** It's the same compiler as the IDE and the build output.
   - Oxlint runs without type-aware rules at first.
   - `oxlint-tsgolint`, which is built on TS 7, can turn type-aware rules on later.
2. **gen-ui formatting: Oxfmt with settings that match the current code.**
   - Settings: Prettier defaults (double quotes, semicolons, trailing commas) and `printWidth: 140`. Today 355 lines are longer than 140 characters and 670 are longer than 120.
   - The reformat goes in a commit of its own, listed in `.git-blame-ignore-revs`.
   - Exclude `*.md`, so the plan docs are left alone.
3. **geogeo single-line imports: drop them.**
   - Oxfmt doesn't run Prettier plugins, custom ones included. Imports past 100 columns will wrap the way plain Prettier wraps them.
   - Alternative: keep Prettier only for formatting. That gives up most of the formatting speed-up and leaves two tools in place.
4. **Node 24 LTS for development in both repos.**
   - Your shell's Node 25 is outside Vitest 5's supported range, and Node 25 reached end of life in June 2026. Tests still pass on it.
   - Vite 8 needs `^20.19 || >=22.12`, so geogeo's `.nvmrc` (22.12.0) would also work. Still, keep one version per repo.
   - Your global gitignore excludes `.node-version`, so pin Node in `.nvmrc` / `.tool-versions`.
   - gen-ui has an untracked local `.node-version` (24), and fnm has Node 24.22.1.
   - Published packages keep `engines.node >=20.19`.
5. **gen-ui libraries keep `tsc` output.**
   - Today's `exports` maps point at one ESM file and one `.d.ts` per source file. TS 7 makes that output fast.
   - A bundler (tsdown) would change the `dist/` layout without a speed reason left to justify it.
6. **No task caching.**
   - `pnpm -r` stays as it was. With TS 7 a full typecheck takes about 2 s.
   - If caching becomes worthwhile, use one that doesn't depend on tracing file access: `tsc -b` incremental builds (`.tsbuildinfo`), or Turborepo with declared `inputs` and `outputs`.
7. **Keep the current pnpm.**
   - The latest pnpm is 12.15. Moving from 9 to 10+ changes the lifecycle-script defaults, which affects geogeo's `postinstall`, workerd and esbuild.
   - That upgrade is its own change.

---

## 4. gen-ui

### Step 0: baseline (done)
On TS 5.9: `pnpm -r build` 10.3 s, `pnpm -r typecheck` 6.5 s, `pnpm -r test` 9.5 s.

### Step 1: TypeScript 7 and a slimmer registry image (done: `0fd73bd`)
- **TypeScript 7:**
  - `typescript` is now `^7.0.2` in the root `package.json`.
  - `baseUrl` is gone from `packages/ui/tsconfig.json`. `paths` (`"@/*": ["./src/*"]`) resolves relative to the tsconfig.
  - In every package, `pnpm exec tsc -v` prints 7.0.2.
  - The lockfile gains `typescript`'s optional platform packages, including linux-x64 and linux-arm64 for Docker.
  - Nothing in gen-ui imports `typescript`, so `@typescript/typescript6` isn't needed.
- **`.pnpmfile.cjs` drops `better-auth`'s optional `vitest` peer** (it's only for its test helpers).
  - pnpm resolved that peer to the workspace's Vitest, so `pnpm deploy --prod` shipped Vitest's dependencies (Rolldown, esbuild, Lightning CSS, chai…) in the registry image.
  - The lockfile changes only in `better-auth`'s entries and `pnpmfileChecksum`.
  - The deploy keeps every package it had except 37 tooling packages, and the image drops from 122 MB to 56 MB.
  - After editing `.pnpmfile.cjs`, run `pnpm install` so `pnpmfileChecksum` matches. Otherwise frozen installs, Docker's included, fail.
- **Checked:**
  - typecheck, build and test pass (185 tests).
  - The `dist/` diff (see Status).
  - The Docker image builds and `/health` returns ok.

### Step 2: Oxfmt and Oxlint (done: `79c2b71`, `44b1beb`, `bcd9e28`, `88418f8`, `227dcdd`)
**Setup:**
- `oxfmt` 0.74 and `oxlint` 1.89 at the root.
- Root scripts:
  - `lint`: `oxlint`
  - `format`: `oxfmt`
  - `check`: `oxfmt --check && oxlint --deny-warnings`

**Differs from the plan below:**
- **Oxfmt also skips `.claude/` and `packages/sdk-python/`.**
  - The Claude app writes `.claude/launch.json` and `settings.json`, so formatting them would churn.
  - The Python SDK's `pyproject.toml` belongs to Python tooling.
- **`.oxlintrc.json` turns off three React Compiler rules:** `set-state-in-effect` (8 findings), `refs` (2) and `purity` (1). The views run on Preact without the compiler and use those patterns on purpose:
  - effects that reset editable state from a new tool result
  - latest-value refs
  - `new Date()` as date-fns' reference date
- **`no-unused-vars` allows `{ [key]: _, ...rest }`.**

**The reformat (`88418f8`) is formatting only:**
- 92 files: TS/TSX, HTML, CSS, JSON/JSONC.
- Every build output was rebuilt and compared:
  - The 22 changed JS files are identical after esbuild minification.
  - The 6 HTML pages keep the same tags and text. Only whitespace at the edges of `p`, `h2`, `li` and `button` content changed, which doesn't render, and no script reads those elements' text.
  - In two ui views, a JSX text `"… "` became `"…"` + `" "`.
- typecheck and all tests passed before the commit.

**Lint fixes (`227dcdd`):**
- 12 `(x?.y as T).z` changed to `x!.y`, in `management.ts` and 11 test lines. The failure stays the same, and the assumption is now stated.
- 4 `?? {}` removed from object spreads.
- One justified `oxlint-disable-next-line` for the listener snapshot in `kit/src/state.ts`.

`git blame` skips `88418f8` once `blame.ignoreRevsFile` is set: `git config blame.ignoreRevsFile .git-blame-ignore-revs`. GitHub reads the file on its own.

**Original plan for this step:**
- Add `oxfmt` and `oxlint` as root dev dependencies.
- **`.oxfmtrc.json`:**
  - `printWidth: 140` (decision 2).
  - `ignorePatterns`: `**/*.md` and `pnpm-lock.yaml`.
  - Oxfmt already skips what `.gitignore` lists (`dist`, `dist-web`, `.wrangler`, `.claude/worktrees`).
- **`.oxlintrc.json`:**
  - The default `correctness` rules, plus `typescript`, `unicorn` and `react` (for the ui views).
  - Ignore `dist` and `dist-web`.
- **Root scripts:**
  - `lint`: `oxlint`
  - `format`: `oxfmt`
  - `check`: `oxfmt --check && oxlint`
- **Commit A:** run `oxfmt` and commit the formatting only, then add its hash to `.git-blame-ignore-revs`.
- **Commit B:** handle the lint findings. With default rules, the Vite+ trial found 18 warnings and no errors:
  - `no-unsafe-optional-chaining` in tests and in `registry/src/management.ts:63`
  - `unicorn/no-useless-fallback-in-spread`
  - `no-useless-spread` in `kit/src/state.ts:195`
  - an unused `_` parameter in `FormView.tsx`
- **Done when:** `pnpm check`, build, typecheck and test pass.

### Step 3: measure (done)
| Command | Time |
|---|---|
| `pnpm check` | 0.5 s (`oxfmt --check` 0.4 s on 200 files; `oxlint` 0.2 s on 148 files with 124 rules) |
| `pnpm typecheck` | 1.9 s |
| `pnpm build` | 5.5 s |
| `pnpm test` | 9.4 s |

---

## 5. geogeo

**Done (2026-10-26).** geogeo now uses the same setup as gen-ui: TS 7, plain Vite 8, Oxlint and Oxfmt.

| geogeo | Before | After |
|---|---|---|
| `pnpm -r typecheck` | 11.5 s, failing (34 errors) | 2.7 s, passing |
| app build | 8.0 s | 2.9–3.3 s |
| landing build | 3.7 s | 2.2 s |
| admin build | 2.2 s | 0.7 s |
| Lint and format | ESLint 3.0 s and Prettier 4.4 s, both failing (1,413 ESLint errors; 229 unformatted files) | `pnpm check` 0.5 s, passing |

| Commit | Step |
|---|---|
| `2788353` | g0: `packageManager` pnpm@9.14.2, no `bun.lock` or `workspaces`, `.nvmrc` 24.11.1 |
| `bc0dac9` | g1: typecheck passes. Includes the combobox fix (`"itemPress"` → `"item-press"`) |
| `3219615` | g2: TypeScript 7 through a catalog. The root stayed on 5.9 until g4 |
| `65756a0` | g3: Vite 8 |
| `73611e8`, `bd8c885` | g4: Oxlint and Oxfmt configs, scripts, ESLint and Prettier removed, `AGENTS.md` |
| `52b7018` | g4: the reformat |
| `aa15c42` | g4: `curly` braces (582) |
| `b3c3482` | g4: the remaining lint fixes and `.git-blame-ignore-revs` |

**g3 (Vite 8):**
- `vite-plugin-pwa` went to 1.3.0, the smallest version that supports Vite 8, instead of 2.0.0. It needs `workbox-window` and `workbox-build` 7.4.1, which are now explicit.
- `vite-plugin-mkcert` stays on 1.17.10. It already supports Vite 8, while 2.x needs Node 22.19+.
- `manualChunks` keeps its function form, which Vite 8 still runs without a warning.
- CSS grew 6–18%. Lightning CSS now honors the `safari15` target and lowers `oklch()` colors to `lab()` with hex fallbacks; before, Safari 15.0–15.3 got colors it can't render.
- Rolldown merged a few small chunks, and the PWA precache list went from 85 to 80 entries.
- Checked:
  - typecheck and the three builds
  - dev servers with `NO_TLS`, and the Pages Functions mocks
  - the HTTPS preview with mkcert certs (your `.env` sets `NO_TLS=1`, so it's off locally by default)
  - the landing and app production builds in Chrome: the map, trails and Paraglide work, with no console errors

**g4 (Oxlint and Oxfmt):**
- Same plugins as gen-ui, plus geogeo's own `curly: all` and `^_` unused-variable patterns.
- Rules that are off:
  - The React Compiler rules, as in gen-ui.
  - `react-hooks/exhaustive-deps`. ESLint never loaded it, and its 25 findings need review, because adding dependencies changes when effects re-run.
- Oxfmt skips `packages/*/public` (vendored emoji CSS) and `project.inlang`.
- The reformat and the `curly` commit are proven mechanical: every changed file compiles to identical minified output. The one exception is three JSX text runs split differently around a space, which render the same text.

**Not done or not checked:**
- **`pnpm deploy:dev`.** Deploys build on the VPS, so first check that its Node is 20.19+ or 22.12+ (Vite 8's requirement).
- **`packages/map`'s own `vite build`.** It fails because `icons.html` points at `src/icons-main.tsx`, which was deleted in `3987bbd`. It was already broken before this work, and no deploy builds `map`.
- **The `better-auth` peer warnings** (drizzle-orm ≥ 0.41, drizzle-kit ≥ 0.31). They predate this work.

### Step g0: housekeeping and baseline (one commit)
- Add `"packageManager": "pnpm@<version the VPS runs>"`.
- Delete `bun.lock` and the `workspaces` field. Bun stays the runtime for the server and `infra/scripts`.
- Use one Node version: 24.x in both `.nvmrc` and `.tool-versions`.
- **On the prod and dev VPS:** check `node -v` and `pnpm -v`. Vite 8 needs `^20.19 || >=22.12`, and deploys build there. Step g3 depends on this.
- Record baseline times for:
  - `pnpm -r typecheck` (14.7 s, and failing)
  - the app, landing and admin builds
  - `eslint .`
  - `prettier --check .`

### Step g1: make typecheck pass (one commit)
It has to pass before it can gate anything.
- **`ui`:** `src/env.ts` uses `import.meta.env` without the `vite/client` types.
- **`map`:** 25 MapLibre style-spec errors, in `styles/shared.ts` and `use-trails-layer.ts`:
  - readonly `as const` expressions don't match the mutable `ExpressionSpecification`
  - layers that may be `undefined`
- **`app`:** 7 errors:
  - Preact's `ComponentChildren` doesn't match `ReactNode`: `badge-frame.tsx` and `share-view.tsx`.
  - `prize-admin.tsx:451` compares against `"itemPress"`, but Base UI now sends `"item-press"`. The check can never be true, so this is a real bug.
  - The spot type doesn't match in `use-map-spots.ts`.
  - `profile.tsx` passes an unknown `imageInitialMode` prop.

### Step g2: TypeScript 7 (one commit)
- Pin `typescript` to `7.0.2` in every package that pins 5.9.3, and in `map` (`^5.9.3`). A pnpm `catalog:` entry keeps the version in one place.
- Keep the root `typescript` on 5.9 until Step g4. typescript-eslint loads it from the root, while each package runs its own `tsc` 7.
- In `packages/ui/tsconfig.json`, remove `baseUrl`. `paths` (`"@ui/*": ["./src/*"]`) still resolves.
- `@trpc/server` and `inngest` list `typescript` only as a types peer (`>=5.7.2`), and 7 satisfies it. `@inngest/ai` keeps its own copy of 5.9.3, which does no harm.
- **Done when:** every package's typecheck passes on TS 7.

### Step g3: Vite 8 (one commit)
- Move `vite` 7.3.1 (app, admin, landing) and ^6.3.0 (map) to 8.3.5, through a `catalog:` entry.
- **Plugin versions for Vite 8:**

  | Package | Now | Target |
  |---|---|---|
  | `@preact/preset-vite` | 2.10.4 | 2.10.6 |
  | `@tailwindcss/vite`, `tailwindcss` | 4.2.2 | 4.3.3 |
  | `vite-plugin-pwa` | 0.21.2 | 2.0.0. Two majors: re-check the `workbox` options and `virtual:pwa-register` |
  | `vite-plugin-mkcert` | 1.17.10 | 2.1.0 |
  | `@inlang/paraglide-js` | 2.16.0 | Check the 2.29 changelog |

- **Config changes:**
  - In app, admin and landing, replace `vite-tsconfig-paths` with `resolve.tsconfigPaths: true`.
  - In app and admin, `build.rollupOptions.output.manualChunks` becomes `build.rolldownOptions.output.codeSplitting.groups`, with groups for `maplibre`, `ui-primitives` and `vendor`, and posthog left async.
    - The function form still works but is deprecated, so this can follow later.
    - Compare the chunk list and sizes against the baseline.
  - In `map`:
    - `esbuild: { jsx, jsxImportSource }` becomes `oxc: { jsx: { runtime: "automatic", importSource: "react" } }`.
    - `rollupOptions` becomes `rolldownOptions`.
  - Remove `rollup-plugin-visualizer`. No config uses it.
- **Done when all of these check out:**
  - Dev servers on 3300, 3302 and 3303, with and without `NO_TLS`.
  - HTTPS preview.
  - The PWA precache list matches the baseline, with the emoji fonts still excluded.
  - Paraglide output.
  - The Pages Functions dev mocks.
  - CSS on Safari 15. Lightning CSS and Oxc are now the minifiers; the explicit target is `["es2020", "safari15"]`.
  - Bundle sizes compared against the baseline.
  - `pnpm deploy:dev` works before prod.

### Step g4: ESLint and Prettier to Oxlint and Oxfmt (two commits)
- **Lint:** `npx @oxlint/migrate` turns `eslint.config.mjs` into `.oxlintrc.json`. Then check the rules carried over:
  - `no-unused-vars` with the `^_` patterns for args, vars and caught errors
  - `curly: "all"`
  - `quotes` and `max-len` move to the formatter
- **Format:** `oxfmt --migrate=prettier` turns `.prettierrc` into `.oxfmtrc.json`: `semi: false`, `trailingComma: "es5"`, `printWidth: 100`, `tabWidth: 2`.
- **Ignore:**
  - Everything in `.prettierignore` and the ESLint ignores
  - `**/routeTree.gen.ts`
  - `packages/*/src/paraglide`
  - The scraped data directories
  - `.pnpm-store`, `.runs` and `.claude`
- **Commit A:** formatting only (decision 3), added to `.git-blame-ignore-revs`. **Commit B:** lint fixes.
- **Remove:**
  - `eslint`, `@eslint/*`, the `@typescript-eslint/*` packages, `eslint-config-prettier`, `eslint-plugin-react` and `prettier`
  - `eslint.config.mjs`, `.prettierrc`, `.prettierignore` and `prettier-plugin-single-line-imports.mjs`
  - Move the root `typescript` to 7.
- **Root scripts:**
  - `lint`: `oxlint`
  - `format`: `oxfmt`
  - add `check`: `oxfmt --check && oxlint`
- In `AGENTS.md`, change the "Linting" section to `pnpm check`.
  - It currently says an ESLint hook runs on changed files. But `~/dotfiles/scripts/eslint-hook.mts` isn't wired into `~/.claude/settings.json`, and it exits when `node_modules/.bin/eslint` is missing.
  - Update or delete that hook separately.

### Step g5: measure
Run Step g0 again and record the times here.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| TS 7 has no JS API until 7.1. A new tool that imports `typescript` (typescript-eslint, ts-morph, vite-plugin-dts) breaks | Alias it: `"typescript": "npm:@typescript/typescript6@^6"` with `"@typescript/native": "npm:typescript@^7"`, then check `tsc -v` |
| The geogeo VPS Node version is unknown | Step g0 checks it before Step g3 lands |
| Vite 7 → 8 output differences in geogeo (Rolldown chunks, Lightning CSS, Oxc minifier, PWA 2.0) | Compare bundles and the precache list. Deploy to dev first |
| Large diffs from the reformat commits | Keep them as separate commits, list them in `.git-blame-ignore-revs`, and land them while no branch is open |
| The IDE still runs TS 5.9 or doesn't know Oxlint and Oxfmt | IntelliJ/WebStorm 2026.2+ for TS 7. The Oxc plugin for lint and format on save |
| An edit to `.pnpmfile.cjs` without `pnpm install` breaks frozen installs | Run `pnpm install` after any change to it |

**Rollback:** each step is one commit on `master`. Run `git revert <sha>`, then `pnpm install`.

**Not in this plan:**
- Vite+
- task caching
- upgrading pnpm
- bundling libraries with tsdown
- replacing `tsx` (gen-ui) or `node --experimental-strip-types` and Bun scripts (geogeo)
- commit hooks
- CI (neither repo has any)
- `app-mcp init` scaffolding TypeScript 7 (it still writes `typescript: ^5.9.3`)
