// A dev registry's starting data, for `pnpm dev:setup` in a worktree: the workspace, an admin token (the CLI),
// a server token (the demo), a password user who manages it, and examples/rating with its workflows in prod.
// Safe to re-run: tokens from the environment that still work are kept, and publishing the same bundle again
// is a no-op. Prints the values for .env.worktree as JSON on stdout; everything else goes to stderr.
import { DEFAULT_ENVIRONMENT } from "@genui/format";
import { readComponentDir, readWorkflowDir } from "@genui/runtime/local";
import { authConfigFromEnv, createAuth } from "../src/auth.js";
import { openDatabase } from "../src/db-node.js";
import { Store, type Scope } from "../src/store.js";

const env = process.env;
const db = openDatabase(env.GENUI_DB ?? "genui-registry.sqlite");
const store = new Store(db);
const config = { ...authConfigFromEnv(env), password: true };

const first = await db.get<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
const workspace = first?.id ?? (await store.createWorkspace(env.GENUI_WORKSPACE ?? "default"));

async function token(scope: Scope, existing: string | undefined): Promise<string> {
  const info = existing ? await store.resolveToken(existing) : undefined;
  return info?.workspaceId === workspace && info.scope === scope ? existing! : store.createToken(workspace, scope, `dev-setup ${scope}`);
}

const email = env.GENUI_DEV_EMAIL ?? "dev@genui.test";
const password = env.GENUI_DEV_PASSWORD ?? "";
if (password.length < 8) throw new Error("GENUI_DEV_PASSWORD must be at least 8 characters");
const user = await db.get<{ id: string }>('SELECT id FROM "user" WHERE email = ?', email.toLowerCase());
const auth = createAuth(db, store, config, fetch);
const userId = user?.id ?? (await auth.api.signUpEmail({ body: { email, password, name: email } })).user.id;
await store.addMember(workspace, userId, "admin");

const example = new URL("../../../examples/rating/", import.meta.url).pathname;
const { manifest, html } = await readComponentDir(example);
const published = await store.publish(workspace, manifest, html, DEFAULT_ENVIRONMENT);
const workflows = await readWorkflowDir(example);
for (const { workflow } of workflows) await store.saveWorkflow(workspace, DEFAULT_ENVIRONMENT, workflow);

console.error(
  `Seeded workspace ${workspace}: ${email} manages it; ${DEFAULT_ENVIRONMENT} serves ${manifest.name}@${published.version} and ${workflows.length} workflows.`,
);
console.log(
  JSON.stringify({
    GENUI_TOKEN: await token("admin", env.GENUI_TOKEN),
    GENUI_MCP_URL: `${config.baseURL}/w/${workspace}/mcp`,
    GENUI_MCP_TOKEN: await token("server", env.GENUI_MCP_TOKEN),
  }),
);
