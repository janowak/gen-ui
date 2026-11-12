# Workflows replace recipes plan

Recipes go away. An environment has **instructions** (the overview) and **workflows** (editable playbooks in the customer's own words). A workflow with params becomes a slash command; one without params is guidance the model always has.

**Status (2026-10-26)**
- Done and on `master`: §2–§10 plus §13 (code path). Recipes, `guide.ts`, `GuideView` and the validation webhook are gone.
- `app-mcp serve` reads workflow files from its dirs and takes `--instructions <file.md>`; `--recipes` and `--guide` are gone.
- Dev mode: no migration of existing recipes, no compat aliases. Local databases get recreated.

**Principle: one concept, the model builds the UI.** Components describe themselves and `render_form` builds any form, so a workflow only needs to say *what to do*. No business-owned fixed forms, no validation webhook. If a customer needs a guaranteed form later, it comes back as an optional part of a workflow, not as its own concept.

---

## 1. What changes for the customer

| Before | After |
|---|---|
| Recipe: fixed form + `when` + `notes` + optional webhook, also `/name` | Gone. The workflow says "show a form with order id and reason, submit to `create_return`" |
| Workflow prompt: name, description, prompt text, always `/name` with a free `details` arg | Workflow: name, description, instructions, optional params |
| Two kinds of slash command that can't share a name | One kind: workflows with params |
| `use_recipe`, `preview_recipe`, `app_mcp_validate` tools | None. `render_form`, `render_chart`, `render_<component>` only |
| Webhook secret, signed `recipe.validate` calls | Gone. The customer's submit tool validates, as for any `render_form` |

## 2. The workflow

```ts
// packages/format/src/workflow.ts (replaces recipe.ts; WorkflowPrompt leaves guide.ts)
export const WorkflowName = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase letters, digits and _; also the slash command name");

export const WorkflowParam = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: z.string().min(1).max(200),   // hosts show it in the slash command's argument hint
  required: z.boolean().default(false),
});

export const Workflow = z.object({
  name: WorkflowName,
  title: z.string().max(80).optional(),
  description: z.string().min(1).max(300),   // when to use it; the command's description
  instructions: z.string().min(1).max(50000), // the playbook: steps, which tools and components, in order
  params: z.array(WorkflowParam).max(10).default([]),
});
```

**With params → slash command.** Registered as an MCP prompt `/<name>` (`/<name>_<env>` outside prod) whose arguments are the params. The message sent to the model:

```
<instructions>

order_id: 1042
reason: arrived broken
```

Empty optional params are left out. MCP prompt arguments are strings, so params are strings too; the instructions say how to read them.

**Without params → always-on guidance.** Not a command. Appended to the server instructions the host gives the model on connect:

```
<environment instructions>

## Workflows
### Return an order (return_order)
When: the user wants to return something.
<instructions>
```

Both kinds are listed in that section by name and description, so the model knows the command ones exist too (only their description, not their full text, to keep the context small).

`serverInstructions(catalog)` in `@app-mcp/format` builds that text; the hosted MCP sends it, so both SDKs pick it up through `getInstructions()` with no change.

**Size.** Hosts send instructions every turn. On save, reject when environment instructions + param-less workflows exceed `MAX_INSTRUCTIONS` (raise to 8000 combined), with an error naming the biggest workflows. Command workflows don't count: their text only goes out when someone runs them.

**References.** On save, warn (not fail) when the instructions name a `render_<x>` tool for a component the environment doesn't serve.

## 3. Storage

- `0001_init.sql`: `recipes` table becomes `workflows (workspace_id, environment, name, workflow TEXT JSON, updated_at)`, same keys. Drop `workspaces.webhook_secret`.
- `0003_branding_guide.sql`: keep `environments.instructions`, drop `environments.prompts`.
- Migrations aren't committed yet, so edit them in place and recreate local D1 / SQLite. If a remote D1 already ran them, add `0004` instead (drop `recipes`, create `workflows`, drop the two columns).
- `store.ts`: `listRecipes/getRecipe/saveRecipe/deleteRecipe` become `listWorkflows/getWorkflow/saveWorkflow/deleteWorkflow` (each save bumps the revision, so refresh URLs fire as today). `getGuide/saveGuide` shrink to `getInstructions/saveInstructions`. Drop the recipe-vs-prompt name checks and `webhookSecret/rotateWebhookSecret`. `deleteEnvironment` and the "unused workspace" check look at `workflows`.
- `Catalog`: `{ environment, theme, components, instructions, workflows }`; `recipes` and `prompts` go.

## 4. Runtime (`packages/runtime/src/runtime.ts`)

- Delete the recipe block: `use_recipe` / `preview_recipe`, `app_mcp_validate`, the per-recipe prompts, `RECIPE_PARAM`, `VIEW_PARAM` if nothing else uses it, the `recipes` and `validate` options.
- Workflow prompts: register only workflows with params, `argsSchema` built from them (`z.string()`, `.optional()` unless required).
- Preview MCP: no prompts, as today. The management MCP can show the composed instructions instead (§6).

## 5. Format clean-up

- Delete `recipe.ts` (`Recipe`, `RecipePrefill`, `RecipeInput`, `recipeForm`). Export `workflow.ts`.
- `guide.ts`: remove `WorkflowPrompt` and `Guide.prompts`; `Guide` becomes just `{ instructions }` or goes away in favour of the plain string. `Branding` and icon types stay (maybe move to `branding.ts`).
- `meta.ts`: remove `FORM_META_KEY` (only `use_recipe` returned a built form). `FormView` renders the tool input only.

## 6. Registry

**API (`api.ts`)**
- `GET /v1/workflows`, `PUT /v1/workflows/:name` (admin), `DELETE /v1/workflows/:name` (admin), `?environment=` as before. Workflows can live as JSON or Markdown-with-frontmatter files in a repo and go out from CI.
- `PUT /v1/instructions` replaces the guide endpoint.
- Remove `/v1/recipes*` and `/v1/hosting/webhook-secret`.

**Hosted MCP (`hosted.ts`)**: send `serverInstructions(catalog)`; drop the `validate` hook.

**Webhook (`webhook.ts`)**: delete `validateWithWebhook` and `signature`. Move `webhookUrlError` (still checks refresh URLs) into `refresh.ts` as `refreshUrlError`. Delete `webhook.test.ts`, keep its URL cases in `refresh.test.ts`.

**Management MCP (`mcp.ts`)**
| Before | After |
|---|---|
| `manage_recipes`, `draft_recipe`, `recipe_save`, `recipe_delete` | `manage_workflows`, `draft_workflow`, `workflow_save`, `workflow_delete` (save/delete app-only, admin) |
| `manage_guide`, `draft_guide`, `guide_save` (instructions + all prompts at once) | `manage_instructions`, `draft_instructions`, `instructions_save` |
| `use_recipe` preview | Gone; `manage_instructions` shows the composed text hosts get |

The `draft_workflow` description teaches the model to write instructions that name `render_form`, `render_chart`, `render_<component>` and the customer's own tools, and to add params only for what a user would type after the command.

## 7. UI (`packages/ui`)

- `RecipesView` → `WorkflowsView`: list (name, description, "command" badge when it has params), detail with the instructions text, params editor (add/remove rows), Save / Delete. Draft mode shows "replaces /x" as recipes do today.
- `GuideView` keeps only the instructions editor plus a read-only preview of the composed server instructions and the size meter against the limit.
- `recipes.html` / `entries/recipes.tsx` → `workflows.html` / `entries/workflows.tsx`; `views.ts` view name `recipes` → `workflows`; `package.json` build entry.
- `FormView`: drop the `FORM_META_KEY` branch.

## 8. CLI and SDKs

- CLI: `app-mcp workflow list | set <file> | rm <name>` (`set` takes `.json` or `.md` with frontmatter: name, title, description, params; body = instructions). `app-mcp instructions set <file.md> | --clear` replaces `app-mcp guide`. Help text and `--env` wording drop "recipe".
- TS SDK (`mount.ts`, `client.ts`, `refresh.ts`): prompts are already mirrored generically; only comments and tests change (`use_recipe` assertions → a workflow prompt with params).
- Python SDK: same, comments/README/tests only (`conftest.py` fixture saves a workflow instead of a recipe).

## 9. Tests

| File | Change |
|---|---|
| `format.test.ts` | Drop recipe cases; `Workflow` parse, `serverInstructions` composition and size |
| `runtime.test.ts` | Command workflows become prompts with the right args and message; param-less ones don't; no `use_recipe` |
| `hosted.test.ts` | Instructions include param-less workflows; per-environment; staging suffix on prompt names |
| `app.test.ts`, `management.test.ts` | Workflow CRUD via API and app-only tools; instructions size rejection |
| `refresh.test.ts` | Workflow save fires the refresh URL; URL checks moved from `webhook.test.ts` |
| `mount.test.ts`, Python tests | Mirror a workflow prompt; no `use_recipe` |

## 10. Docs and demos

- `README.md`, `packages/sdk-python/README.md`, `apps/site/index.html` (Recipes section → Workflows; "theme and recipe saves" → "theme and workflow saves"), `apps/registry/web/consent.html`.
- `apps/playground/src/presets.ts`: drop the `create_order` recipe preset.
- `apps/demo/src/main.ts`: comment only.
- `DEV-SERVE-PLAN.md`: `--recipes` → `--workflows <dir>`.
- Older plan docs are history; leave them.

## 11. Order

1. Format: `workflow.ts`, `serverInstructions`, remove recipe/prompt types. Typecheck shows every caller.
2. Migrations + store + catalog.
3. Runtime prompts; hosted instructions; delete webhook validation.
4. API, management MCP, views.
5. CLI, SDK comments, docs, playground.
6. `pnpm test` across packages and Python tests; run the demo against a local registry and check in Claude that a command workflow appears as `/name` with its args and a param-less one shows up in the instructions.

## 12. Open questions

- Should a param-less workflow also be startable as a command (no args)? This plan says no: params are the switch, as asked.
- Combined instructions limit: 8000 characters is a guess; check what Claude and ChatGPT truncate at.
- Param types beyond string (enum hints for autocomplete via MCP `completion/complete`)? Not now.

## 13. Code path: workflows next to components

Workflows live in the repo next to the components they use and ship the same way:

- `<name>.workflow.md` in a component dir or its `workflows/`: YAML frontmatter (`title`, `description`, `params`; `name` defaults to the file name) and the instructions as the body. `.json` works for `app-mcp workflow set`.
- `app-mcp publish <dir>` sends the dir's component and its workflows to the environment (`PUT /v1/workflows/:name`), with the same publish token and its environment limits. A dir may hold only workflows.
- `app-mcp workflow list | set <file> | rm <name>` for single ones; `app-mcp instructions <file.md> | --clear` for the environment's instructions (admin).
- `@app-mcp/runtime/local`: `parseWorkflowFile`, `readWorkflowFile`, `readWorkflowDir`, also used by `app-mcp serve`.
- Publishing doesn't delete workflows that left the repo; `app-mcp workflow rm` does. A sync mode (`--prune`) can come later.
- Example: `examples/rating/workflows/` (`create_order` is a command, `order_feedback` is always-on).
