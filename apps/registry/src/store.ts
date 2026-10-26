import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_ENVIRONMENT,
  MAX_ICON_BYTES,
  type Branding,
  type Catalog,
  type CatalogComponent,
  type ComponentManifest,
  type Guide,
  type IconType,
  type Recipe,
  type Theme,
  type WorkflowPrompt,
} from "@genui/format";
import { breakingChanges, compareSemver } from "./compat.js";
import { statement, type Database, type Statement } from "./db.js";

export type Scope = "server" | "publish" | "admin";
export type Role = "member" | "admin";

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
  /** Active environment in the management MCP: what previews, theme and recipes show. */
  environment: string;
}

export interface TokenSummary {
  id: string;
  name: string;
  scope: Scope;
  environments: string[] | null;
  createdAt: string;
}

export interface MemberSummary {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
}

export interface InviteSummary {
  email: string;
  role: Role;
}

export interface TokenInfo {
  workspaceId: string;
  scope: Scope;
  /** Environments a publish token may publish to; null means all. */
  environments: string[] | null;
}

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The workspace's connector branding; the icon's bytes are served separately. */
export interface WorkspaceBranding extends Branding {
  icon: { type: IconType; hash: string } | null;
}

/** The icon's format, read from its bytes rather than trusted from the upload. */
export function sniffIcon(bytes: Uint8Array): IconType | undefined {
  const starts = (...magic: number[]) => magic.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return undefined;
}

const now = () => new Date().toISOString();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type EnvironmentRow = { name: string; revision: number; refresh_url: string | null; last_refresh: string | null };
const environmentInfo = (row: EnvironmentRow): EnvironmentInfo => ({
  name: row.name,
  revision: row.revision,
  refreshUrl: row.refresh_url,
  lastRefresh: row.last_refresh ? (JSON.parse(row.last_refresh) as LastRefresh) : null,
});

export interface ComponentSummary {
  name: string;
  /** The version each environment serves. */
  environments: Record<string, string>;
  versions: string[];
}

export interface PublishResult {
  version: string;
  hash: string;
  created: boolean;
  environment: string;
  /** The version each environment serves after the publish. */
  environments: Record<string, string>;
  /** Breaking props changes against the version the environment served before. */
  warnings: string[];
}

/** What genui last got back from an environment's refresh URL. */
export interface LastRefresh {
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface EnvironmentInfo {
  name: string;
  /** Bumped by every change to what the environment serves. */
  revision: number;
  /** The company's server endpoint genui calls on each change (@genui/sdk's refresh handler). */
  refreshUrl: string | null;
  lastRefresh: LastRefresh | null;
}

/** A committed change to what an environment serves: versions, theme or recipes. */
export interface EnvironmentChange {
  workspaceId: string;
  environment: string;
  revision: number;
}

/**
 * Whether a workspace is in use: more than one member, or anything published, saved, issued or invited.
 * `?1` is the workspace id.
 */
const WORKSPACE_USED = `((SELECT COUNT(*) FROM members WHERE workspace_id = ?1) > 1
  OR EXISTS (SELECT 1 FROM components WHERE workspace_id = ?1)
  OR EXISTS (SELECT 1 FROM recipes WHERE workspace_id = ?1)
  OR EXISTS (SELECT 1 FROM tokens WHERE workspace_id = ?1)
  OR EXISTS (SELECT 1 FROM invites WHERE workspace_id = ?1))`;

/** SQLite's error for a duplicate key, in node:sqlite's and D1's messages alike. */
const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/**
 * All registry data access. Every query is scoped to a workspace. Writes that belong together run in
 * one atomic batch: D1 has no interactive transactions, so reads come first and the batch's statements
 * guard themselves where a concurrent write could interfere.
 */
export class Store {
  private readonly listeners = new Set<(change: EnvironmentChange) => void>();

  constructor(private readonly db: Database) {}

  /** Calls `listener` after every committed change to what an environment serves. Returns an unsubscribe function. */
  onChange(listener: (change: EnvironmentChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs a change to what an environment serves together with its revision bump, in one batch, then
   * tells listeners. Returns each statement's rows.
   */
  private async change(workspaceId: string, environment: string, statements: Statement[]): Promise<unknown[][]> {
    const results = await this.db.batch([
      ...statements,
      statement("UPDATE environments SET revision = revision + 1 WHERE workspace_id = ? AND name = ? RETURNING revision", workspaceId, environment),
    ]);
    const [bumped] = results.at(-1) as { revision: number }[];
    if (bumped) for (const listener of this.listeners) listener({ workspaceId, environment, revision: bumped.revision });
    return results;
  }

  // Workspaces and tokens

  /** A new workspace with its prod environment. Its public end-user MCP is on until an admin turns it off. */
  private newWorkspace(name: string): { id: string; statements: Statement[] } {
    const id = randomUUID();
    const createdAt = now();
    return {
      id,
      statements: [
        statement("INSERT INTO workspaces (id, name, hosted, created_at) VALUES (?, ?, 1, ?)", id, name, createdAt),
        statement("INSERT INTO environments (workspace_id, name, created_at) VALUES (?, ?, ?)", id, DEFAULT_ENVIRONMENT, createdAt),
      ],
    };
  }

  async createWorkspace(name: string): Promise<string> {
    const { id, statements } = this.newWorkspace(name);
    await this.db.batch(statements);
    return id;
  }

  async countWorkspaces(): Promise<number> {
    return Number((await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces"))!.n);
  }

  workspace(workspaceId: string): Promise<{ id: string; name: string } | undefined> {
    return this.db.get("SELECT id, name FROM workspaces WHERE id = ?", workspaceId);
  }

  /** The workspace, if the registry hosts its end-user MCP. */
  hostedWorkspace(workspaceId: string): Promise<{ id: string; name: string } | undefined> {
    return this.db.get("SELECT id, name FROM workspaces WHERE id = ? AND hosted = 1", workspaceId);
  }

  async isHosted(workspaceId: string): Promise<boolean> {
    return Boolean(await this.hostedWorkspace(workspaceId));
  }

  async setHosted(workspaceId: string, hosted: boolean): Promise<void> {
    await this.db.run("UPDATE workspaces SET hosted = ? WHERE id = ?", hosted ? 1 : 0, workspaceId);
  }

  /** The secret recipe validation webhooks are signed with; created on first use. */
  async webhookSecret(workspaceId: string): Promise<string> {
    const row = await this.db.get<{ webhook_secret: string | null }>("SELECT webhook_secret FROM workspaces WHERE id = ?", workspaceId);
    if (row?.webhook_secret) return row.webhook_secret;
    // Two first uses at once keep whichever secret was written first.
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await this.db.run("UPDATE workspaces SET webhook_secret = ? WHERE id = ? AND webhook_secret IS NULL", secret, workspaceId);
    return (await this.db.get<{ webhook_secret: string }>("SELECT webhook_secret FROM workspaces WHERE id = ?", workspaceId))!.webhook_secret;
  }

  async rotateWebhookSecret(workspaceId: string): Promise<string> {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await this.db.run("UPDATE workspaces SET webhook_secret = ? WHERE id = ?", secret, workspaceId);
    return secret;
  }

  // Branding: how the end-user MCP presents itself to hosts. Hosted servers are built per request, so
  // a change shows on the next connection; nothing to re-list.

  async branding(workspaceId: string): Promise<WorkspaceBranding> {
    const row = await this.db.get<{ title: string | null; description: string | null; website_url: string | null; icon_type: IconType | null; icon_hash: string | null }>(
      "SELECT title, description, website_url, icon_type, icon_hash FROM workspaces WHERE id = ?",
      workspaceId,
    );
    return {
      ...(row?.title ? { title: row.title } : {}),
      ...(row?.description ? { description: row.description } : {}),
      ...(row?.website_url ? { websiteUrl: row.website_url } : {}),
      icon: row?.icon_type && row.icon_hash ? { type: row.icon_type, hash: row.icon_hash } : null,
    };
  }

  /** Replaces title, description and website; unset ones are cleared. The icon stays. */
  async setBranding(workspaceId: string, branding: Branding): Promise<void> {
    await this.db.run(
      "UPDATE workspaces SET title = ?, description = ?, website_url = ? WHERE id = ?",
      branding.title ?? null,
      branding.description ?? null,
      branding.websiteUrl ?? null,
      workspaceId,
    );
  }

  /** Sets (PNG, JPEG, WebP or SVG, up to MAX_ICON_BYTES) or clears (null) the connector icon. */
  async setIcon(workspaceId: string, bytes: Uint8Array | null): Promise<void> {
    if (!bytes) {
      await this.db.run("UPDATE workspaces SET icon = NULL, icon_type = NULL, icon_hash = NULL WHERE id = ?", workspaceId);
      return;
    }
    if (bytes.byteLength > MAX_ICON_BYTES) throw new RegistryError(413, `The icon is over ${MAX_ICON_BYTES / 1000} KB`);
    const type = sniffIcon(bytes);
    if (!type) throw new RegistryError(400, "The icon must be a PNG, JPEG, WebP or SVG image");
    const data = Buffer.from(bytes);
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    await this.db.run("UPDATE workspaces SET icon = ?, icon_type = ?, icon_hash = ? WHERE id = ?", data.toString("base64"), type, hash, workspaceId);
  }

  async icon(workspaceId: string): Promise<{ type: IconType; hash: string; bytes: Uint8Array } | undefined> {
    const row = await this.db.get<{ icon: string | null; icon_type: IconType | null; icon_hash: string | null }>(
      "SELECT icon, icon_type, icon_hash FROM workspaces WHERE id = ?",
      workspaceId,
    );
    if (!row?.icon || !row.icon_type || !row.icon_hash) return undefined;
    return { type: row.icon_type, hash: row.icon_hash, bytes: new Uint8Array(Buffer.from(row.icon, "base64")) };
  }

  /** Returns the plaintext token once; only its hash is stored. `environments` limits a publish token. */
  async createToken(workspaceId: string, scope: Scope, name: string, environments?: string[]): Promise<string> {
    for (const environment of environments ?? []) await this.requireEnvironment(workspaceId, environment);
    const token = `gnu_${scope}_${randomBytes(24).toString("base64url")}`;
    await this.db.run(
      "INSERT INTO tokens (id, workspace_id, name, scope, environments, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      randomUUID(),
      workspaceId,
      name,
      scope,
      environments ? JSON.stringify(environments) : null,
      sha256(token),
      now(),
    );
    return token;
  }

  async listTokens(workspaceId: string): Promise<TokenSummary[]> {
    const rows = await this.db.all<{ id: string; name: string; scope: Scope; environments: string | null; created_at: string }>(
      "SELECT id, name, scope, environments, created_at FROM tokens WHERE workspace_id = ? ORDER BY created_at",
      workspaceId,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, environments: r.environments ? (JSON.parse(r.environments) as string[]) : null, createdAt: r.created_at }));
  }

  /** Servers and CI using the token get 401 from their next request. */
  async revokeToken(workspaceId: string, id: string): Promise<void> {
    const { changes } = await this.db.run("DELETE FROM tokens WHERE workspace_id = ? AND id = ?", workspaceId, id);
    if (!changes) throw new RegistryError(404, "No such token");
  }

  async resolveToken(token: string): Promise<TokenInfo | undefined> {
    const row = await this.db.get<{ workspace_id: string; scope: Scope; environments: string | null }>(
      "SELECT workspace_id, scope, environments FROM tokens WHERE hash = ?",
      sha256(token),
    );
    return row && { workspaceId: row.workspace_id, scope: row.scope, environments: row.environments ? (JSON.parse(row.environments) as string[]) : null };
  }

  // Environments

  /** The workspace's environments, prod first. */
  async listEnvironments(workspaceId: string): Promise<string[]> {
    const rows = await this.db.all<{ name: string }>("SELECT name FROM environments WHERE workspace_id = ? ORDER BY name != ?, name", workspaceId, DEFAULT_ENVIRONMENT);
    return rows.map((r) => r.name);
  }

  async hasEnvironment(workspaceId: string, name: string): Promise<boolean> {
    return Boolean(await this.db.get("SELECT 1 FROM environments WHERE workspace_id = ? AND name = ?", workspaceId, name));
  }

  /** Environments are created explicitly, so a typo fails instead of creating one. */
  async requireEnvironment(workspaceId: string, name: string): Promise<void> {
    if (!(await this.hasEnvironment(workspaceId, name))) throw new RegistryError(404, `Environment "${name}" doesn't exist. Create it with: genui env add ${name}`);
  }

  async createEnvironment(workspaceId: string, name: string): Promise<void> {
    const { changes } = await this.db.run(
      "INSERT INTO environments (workspace_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      workspaceId,
      name,
      now(),
    );
    if (!changes) throw new RegistryError(409, `Environment "${name}" already exists`);
  }

  async environment(workspaceId: string, name: string): Promise<EnvironmentInfo | undefined> {
    const row = await this.db.get<EnvironmentRow>(
      "SELECT name, revision, refresh_url, last_refresh FROM environments WHERE workspace_id = ? AND name = ?",
      workspaceId,
      name,
    );
    return row && environmentInfo(row);
  }

  /** The workspace's environments with their refresh settings, prod first. */
  async listEnvironmentInfo(workspaceId: string): Promise<EnvironmentInfo[]> {
    const rows = await this.db.all<EnvironmentRow>(
      "SELECT name, revision, refresh_url, last_refresh FROM environments WHERE workspace_id = ? ORDER BY name != ?, name",
      workspaceId,
      DEFAULT_ENVIRONMENT,
    );
    return rows.map(environmentInfo);
  }

  /** Sets or clears (null) the URL genui calls when what the environment serves changes. */
  async setRefreshUrl(workspaceId: string, name: string, url: string | null): Promise<void> {
    await this.requireEnvironment(workspaceId, name);
    await this.db.run("UPDATE environments SET refresh_url = ?, last_refresh = NULL WHERE workspace_id = ? AND name = ?", url, workspaceId, name);
  }

  async setLastRefresh(workspaceId: string, name: string, result: LastRefresh): Promise<void> {
    await this.db.run("UPDATE environments SET last_refresh = ? WHERE workspace_id = ? AND name = ?", JSON.stringify(result), workspaceId, name);
  }

  /** Deletes an environment with what it serves: its deployments, theme and recipes. */
  async deleteEnvironment(workspaceId: string, name: string): Promise<void> {
    if (name === DEFAULT_ENVIRONMENT) throw new RegistryError(400, `${DEFAULT_ENVIRONMENT} can't be deleted`);
    await this.requireEnvironment(workspaceId, name);
    await this.db.batch([
      statement("DELETE FROM deployments WHERE environment = ? AND component_id IN (SELECT id FROM components WHERE workspace_id = ?)", name, workspaceId),
      statement("DELETE FROM recipes WHERE workspace_id = ? AND environment = ?", workspaceId, name),
      statement("DELETE FROM environments WHERE workspace_id = ? AND name = ?", workspaceId, name),
    ]);
  }

  // Members (people managing a workspace through the registry MCP)

  /** Without a workspace: the one the person joined last, so an accepted invite wins over a personal workspace. */
  async membership(userId: string, workspaceId?: string): Promise<Membership | undefined> {
    // A deleted active environment falls back to prod.
    const select = `SELECT m.workspace_id, m.role, e.name AS environment FROM members m
      LEFT JOIN environments e ON e.workspace_id = m.workspace_id AND e.name = m.environment WHERE m.user_id = ?`;
    type Row = { workspace_id: string; role: Role; environment: string | null };
    const row = workspaceId
      ? await this.db.get<Row>(`${select} AND m.workspace_id = ?`, userId, workspaceId)
      : await this.db.get<Row>(`${select} ORDER BY m.created_at DESC LIMIT 1`, userId);
    return row && { workspaceId: row.workspace_id, userId, role: row.role, environment: row.environment ?? DEFAULT_ENVIRONMENT };
  }

  async setActiveEnvironment(workspaceId: string, userId: string, environment: string): Promise<void> {
    await this.requireEnvironment(workspaceId, environment);
    await this.db.run("UPDATE members SET environment = ? WHERE workspace_id = ? AND user_id = ?", environment, workspaceId, userId);
  }

  private memberStatement(workspaceId: string, userId: string, role: Role): Statement {
    return statement(
      "INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role",
      workspaceId,
      userId,
      role,
      now(),
    );
  }

  async addMember(workspaceId: string, userId: string, role: Role): Promise<void> {
    await this.db.batch([this.memberStatement(workspaceId, userId, role)]);
  }

  /** Members with the name and email they signed in with; invites still waiting for a first sign-in. */
  async listMembers(workspaceId: string): Promise<{ members: MemberSummary[]; invites: InviteSummary[] }> {
    const [members, invites] = await Promise.all([
      this.db.all<{ user_id: string; role: Role; name: string | null; email: string | null }>(
        "SELECT m.user_id, m.role, u.name, u.email FROM members m LEFT JOIN user u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at",
        workspaceId,
      ),
      this.db.all<InviteSummary>("SELECT email, role FROM invites WHERE workspace_id = ? ORDER BY created_at", workspaceId),
    ]);
    return { members: members.map((m) => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role })), invites };
  }

  async cancelInvite(workspaceId: string, email: string): Promise<void> {
    const { changes } = await this.db.run("DELETE FROM invites WHERE workspace_id = ? AND email = ?", workspaceId, email.toLowerCase());
    if (!changes) throw new RegistryError(404, `No pending invite for ${email}`);
  }

  async invite(workspaceId: string, email: string, role: Role): Promise<void> {
    await this.db.run(
      "INSERT INTO invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role",
      workspaceId,
      email.toLowerCase(),
      role,
      now(),
    );
  }

  /**
   * Deletes a workspace nobody used: one member, nothing published, no recipes, tokens or invites. Each
   * statement re-checks, so a workspace someone starts using meanwhile stays.
   */
  private deleteIfUnused(workspaceId: string): Statement[] {
    return ["members", "environments"]
      .map((table) => statement(`DELETE FROM ${table} WHERE workspace_id = ?1 AND NOT ${WORKSPACE_USED}`, workspaceId))
      .concat(statement(`DELETE FROM workspaces WHERE id = ?1 AND NOT ${WORKSPACE_USED}`, workspaceId));
  }

  /**
   * Finds or creates the signed-in person's membership:
   * pending invite → existing membership → sign-up gate → self-hosted single workspace → (hosted) a new personal workspace.
   * With `allowedEmails` set, only listed verified emails (or `@domain` entries) get past the gate; the rest get no
   * membership until someone invites them.
   */
  async resolveMembership(
    user: { id: string; email: string; emailVerified: boolean; name?: string },
    options: { mode: "hosted" | "self-hosted"; adminEmails: string[]; allowedEmails?: string[] },
  ): Promise<Membership | undefined> {
    // Invites and admin emails grant access by email, so only a verified email (GitHub, Google,
    // company IdP) may claim them. Unverified password sign-ups never match.
    const email = user.emailVerified ? user.email.toLowerCase() : undefined;
    const invite = email
      ? await this.db.get<{ workspace_id: string; role: Role }>("SELECT workspace_id, role FROM invites WHERE email = ? ORDER BY created_at LIMIT 1", email)
      : undefined;
    // An invite wins even for people who already have a workspace, e.g. one made at an earlier sign-in.
    if (invite && email) {
      const previous = await this.membership(user.id);
      await this.db.batch([
        this.memberStatement(invite.workspace_id, user.id, invite.role),
        statement("DELETE FROM invites WHERE workspace_id = ? AND email = ?", invite.workspace_id, email),
        ...(previous && previous.workspaceId !== invite.workspace_id ? this.deleteIfUnused(previous.workspaceId) : []),
      ]);
      return this.membership(user.id, invite.workspace_id);
    }

    const existing = await this.membership(user.id);
    if (existing) return existing;

    const allowed = options.allowedEmails ?? [];
    if (allowed.length > 0) {
      const listed = email !== undefined && (allowed.includes(email) || allowed.includes(email.slice(email.lastIndexOf("@"))));
      if (!listed && !(email !== undefined && options.adminEmails.includes(email))) return undefined;
    }

    if (options.mode === "self-hosted") {
      const workspace = await this.db.get<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
      if (!workspace) return undefined;
      const hasAdmin = await this.db.get("SELECT 1 FROM members WHERE workspace_id = ? AND role = 'admin'", workspace.id);
      // Whoever can sign in through the company IdP may manage. Admins: the listed (verified) emails;
      // only when no list is configured, the first person to sign in.
      const listed = email !== undefined && options.adminEmails.includes(email);
      const firstPerson = !hasAdmin && options.adminEmails.length === 0;
      const role: Role = listed || firstPerson ? "admin" : "member";
      await this.addMember(workspace.id, user.id, role);
      return this.membership(user.id, workspace.id);
    }

    const workspace = this.newWorkspace(`${user.name || user.email}'s workspace`);
    await this.db.batch([...workspace.statements, this.memberStatement(workspace.id, user.id, "admin")]);
    return this.membership(user.id, workspace.id);
  }

  // Recipes: per environment, live in that environment on save.

  async listRecipes(workspaceId: string, environment: string): Promise<Recipe[]> {
    const rows = await this.db.all<{ recipe: string }>("SELECT recipe FROM recipes WHERE workspace_id = ? AND environment = ? ORDER BY name", workspaceId, environment);
    return rows.map((r) => JSON.parse(r.recipe) as Recipe);
  }

  async getRecipe(workspaceId: string, environment: string, name: string): Promise<Recipe | undefined> {
    const row = await this.db.get<{ recipe: string }>(
      "SELECT recipe FROM recipes WHERE workspace_id = ? AND environment = ? AND name = ?",
      workspaceId,
      environment,
      name,
    );
    return row ? (JSON.parse(row.recipe) as Recipe) : undefined;
  }

  /** Creates or replaces a recipe. Returns true when it replaced an existing one. */
  async saveRecipe(workspaceId: string, environment: string, recipe: Recipe): Promise<boolean> {
    await this.requireEnvironment(workspaceId, environment);
    // Each recipe is also a slash command, so it can't share a name with a workflow prompt.
    if ((await this.getGuide(workspaceId, environment)).prompts.some((p) => p.name === recipe.name)) {
      throw new RegistryError(409, `/${recipe.name} is already a workflow prompt in ${environment}`);
    }
    const existed = Boolean(await this.getRecipe(workspaceId, environment, recipe.name));
    await this.change(workspaceId, environment, [
      statement(
        "INSERT INTO recipes (workspace_id, environment, name, recipe, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, environment, name) DO UPDATE SET recipe = excluded.recipe, updated_at = excluded.updated_at",
        workspaceId,
        environment,
        recipe.name,
        JSON.stringify(recipe),
        now(),
      ),
    ]);
    return existed;
  }

  async deleteRecipe(workspaceId: string, environment: string, name: string): Promise<void> {
    if (!(await this.getRecipe(workspaceId, environment, name))) throw new RegistryError(404, `Recipe "${name}" not found in ${environment}`);
    await this.change(workspaceId, environment, [statement("DELETE FROM recipes WHERE workspace_id = ? AND environment = ? AND name = ?", workspaceId, environment, name)]);
  }

  // Theme: per environment.

  async getTheme(workspaceId: string, environment: string): Promise<Theme | null> {
    const row = await this.db.get<{ theme: string | null }>("SELECT theme FROM environments WHERE workspace_id = ? AND name = ?", workspaceId, environment);
    return row?.theme ? (JSON.parse(row.theme) as Theme) : null;
  }

  async setTheme(workspaceId: string, environment: string, theme: Theme | null): Promise<void> {
    await this.requireEnvironment(workspaceId, environment);
    await this.change(workspaceId, environment, [
      statement("UPDATE environments SET theme = ? WHERE workspace_id = ? AND name = ?", theme ? JSON.stringify(theme) : null, workspaceId, environment),
    ]);
  }

  // Guide: per environment, the end-user MCP's instructions and workflow prompts.

  async getGuide(workspaceId: string, environment: string): Promise<Guide> {
    const row = await this.db.get<{ instructions: string | null; prompts: string | null }>(
      "SELECT instructions, prompts FROM environments WHERE workspace_id = ? AND name = ?",
      workspaceId,
      environment,
    );
    return {
      ...(row?.instructions ? { instructions: row.instructions } : {}),
      prompts: row?.prompts ? (JSON.parse(row.prompts) as WorkflowPrompt[]) : [],
    };
  }

  /** Replaces the environment's instructions and workflow prompts. */
  async setGuide(workspaceId: string, environment: string, guide: Guide): Promise<void> {
    await this.requireEnvironment(workspaceId, environment);
    const names = new Set<string>();
    const recipes = new Set((await this.listRecipes(workspaceId, environment)).map((r) => r.name));
    for (const { name } of guide.prompts) {
      if (names.has(name)) throw new RegistryError(400, `Two workflow prompts are named /${name}`);
      if (recipes.has(name)) throw new RegistryError(409, `/${name} is already a recipe in ${environment}`);
      names.add(name);
    }
    await this.change(workspaceId, environment, [
      statement(
        "UPDATE environments SET instructions = ?, prompts = ? WHERE workspace_id = ? AND name = ?",
        guide.instructions?.trim() || null,
        guide.prompts.length ? JSON.stringify(guide.prompts) : null,
        workspaceId,
        environment,
      ),
    ]);
  }

  // Components

  /**
   * Points an environment at a version and reports what changed. `create` holds the statements that
   * insert a new version; they run in the same batch, so a new version is never left undeployed.
   */
  private async deploy(
    workspaceId: string,
    name: string,
    environment: string,
    version: { id: string; manifest: ComponentManifest },
    result: Pick<PublishResult, "version" | "hash" | "created">,
    create: Statement[] = [],
  ): Promise<PublishResult> {
    const current = await this.db.get<{ version_id: string; version: string; manifest: string }>(
      `SELECT d.version_id, v.version, v.manifest FROM deployments d
       JOIN components co ON co.id = d.component_id JOIN versions v ON v.id = d.version_id
       WHERE co.workspace_id = ? AND co.name = ? AND d.environment = ?`,
      workspaceId,
      name,
      environment,
    );
    // Breaking props only warn: which version an environment serves is the publisher's call.
    const warnings = current
      ? breakingChanges((JSON.parse(current.manifest) as ComponentManifest).props, version.manifest.props).map(
          (issue) => `${issue} (${environment} served ${current.version})`,
        )
      : [];
    // A re-run CI job points the environment at what it already serves: nothing changes.
    if (current?.version_id !== version.id) {
      await this.change(workspaceId, environment, [
        ...create,
        statement(
          `INSERT INTO deployments (component_id, environment, version_id) SELECT id, ?, ? FROM components WHERE workspace_id = ? AND name = ?
           ON CONFLICT (component_id, environment) DO UPDATE SET version_id = excluded.version_id`,
          environment,
          version.id,
          workspaceId,
          name,
        ),
      ]);
    }
    return { ...result, environment, environments: await this.deployedVersions(workspaceId, name), warnings };
  }

  private async deployedVersions(workspaceId: string, name: string): Promise<Record<string, string>> {
    const rows = await this.db.all<{ environment: string; version: string }>(
      `SELECT d.environment, v.version FROM deployments d
       JOIN components co ON co.id = d.component_id JOIN versions v ON v.id = d.version_id
       WHERE co.workspace_id = ? AND co.name = ? ORDER BY d.environment != ?, d.environment`,
      workspaceId,
      name,
      DEFAULT_ENVIRONMENT,
    );
    return Object.fromEntries(rows.map((r) => [r.environment, r.version]));
  }

  private publishedVersion(workspaceId: string, name: string, version: string) {
    return this.db.get<{ id: string; hash: string; manifest: string }>(
      "SELECT v.id, v.hash, v.manifest FROM versions v JOIN components co ON co.id = v.component_id WHERE co.workspace_id = ? AND co.name = ? AND v.version = ?",
      workspaceId,
      name,
      version,
    );
  }

  /**
   * Publishes an immutable version and points the environment at it, older versions included. Publishing
   * the same version with the same bundle and manifest again only points the environment, so CI jobs can be re-run.
   */
  async publish(workspaceId: string, manifest: ComponentManifest, html: string, environment: string = DEFAULT_ENVIRONMENT): Promise<PublishResult> {
    await this.requireEnvironment(workspaceId, environment);
    const hash = sha256(html).slice(0, 16);
    const json = JSON.stringify(manifest);

    const same = await this.publishedVersion(workspaceId, manifest.name, manifest.version);
    if (same) {
      if (same.hash !== hash || same.manifest !== json) {
        throw new RegistryError(
          409,
          `${manifest.name}@${manifest.version} already exists with different content; versions are immutable. To serve it here without rebuilding: genui publish ${manifest.name}@${manifest.version} --env ${environment}`,
        );
      }
      return this.deploy(workspaceId, manifest.name, environment, { id: same.id, manifest }, { version: manifest.version, hash, created: false });
    }

    const versionId = randomUUID();
    const createdAt = now();
    try {
      return await this.deploy(workspaceId, manifest.name, environment, { id: versionId, manifest }, { version: manifest.version, hash, created: true }, [
        statement("INSERT INTO components (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", randomUUID(), workspaceId, manifest.name, createdAt),
        statement(
          "INSERT INTO versions (id, component_id, version, hash, manifest, html, created_at) SELECT ?, id, ?, ?, ?, ?, ? FROM components WHERE workspace_id = ? AND name = ?",
          versionId,
          manifest.version,
          hash,
          json,
          html,
          createdAt,
          workspaceId,
          manifest.name,
        ),
      ]);
    } catch (error) {
      // Another publish of this version got there first: answer as a re-run (or a conflict) against it.
      if (isUniqueViolation(error) && (await this.publishedVersion(workspaceId, manifest.name, manifest.version))) {
        return this.publish(workspaceId, manifest, html, environment);
      }
      throw error;
    }
  }

  /** Points an environment at a version that's already published: the same bundle, no rebuild. */
  async deployVersion(workspaceId: string, name: string, version: string, environment: string): Promise<PublishResult> {
    await this.requireEnvironment(workspaceId, environment);
    const row = await this.publishedVersion(workspaceId, name, version);
    if (!row) {
      if (!(await this.db.get("SELECT 1 FROM components WHERE workspace_id = ? AND name = ?", workspaceId, name))) {
        throw new RegistryError(404, `Component "${name}" not found`);
      }
      throw new RegistryError(404, `${name}@${version} isn't published`);
    }
    return this.deploy(workspaceId, name, environment, { id: row.id, manifest: JSON.parse(row.manifest) as ComponentManifest }, { version, hash: row.hash, created: false });
  }

  async listComponents(workspaceId: string): Promise<ComponentSummary[]> {
    // Three queries for the whole workspace, not three per component: each one is a round trip on D1.
    const [components, versions, deployments] = await Promise.all([
      this.db.all<{ id: string; name: string }>("SELECT id, name FROM components WHERE workspace_id = ? ORDER BY name", workspaceId),
      this.db.all<{ component_id: string; version: string }>(
        "SELECT v.component_id, v.version FROM versions v JOIN components co ON co.id = v.component_id WHERE co.workspace_id = ?",
        workspaceId,
      ),
      this.db.all<{ component_id: string; environment: string; version: string }>(
        `SELECT d.component_id, d.environment, v.version FROM deployments d
         JOIN components co ON co.id = d.component_id JOIN versions v ON v.id = d.version_id
         WHERE co.workspace_id = ? ORDER BY d.environment != ?, d.environment`,
        workspaceId,
        DEFAULT_ENVIRONMENT,
      ),
    ]);
    return components.map(({ id, name }) => ({
      name,
      environments: Object.fromEntries(deployments.filter((d) => d.component_id === id).map((d) => [d.environment, d.version])),
      versions: versions
        .filter((v) => v.component_id === id)
        .map((v) => v.version)
        .sort((a, b) => compareSemver(b, a)),
    }));
  }

  async catalog(workspaceId: string, environment: string): Promise<Catalog> {
    const [rows, theme, recipes, guide] = await Promise.all([
      this.db.all<{ name: string; version: string; hash: string; manifest: string }>(
        `SELECT co.name, v.version, v.hash, v.manifest FROM deployments d
         JOIN components co ON co.id = d.component_id
         JOIN versions v ON v.id = d.version_id
         WHERE co.workspace_id = ? AND d.environment = ? ORDER BY co.name`,
        workspaceId,
        environment,
      ),
      this.getTheme(workspaceId, environment),
      this.listRecipes(workspaceId, environment),
      this.getGuide(workspaceId, environment),
    ]);
    const components: CatalogComponent[] = rows.map((r) => ({ name: r.name, version: r.version, hash: r.hash, manifest: JSON.parse(r.manifest) }));
    return { environment, theme, components, recipes, instructions: guide.instructions ?? null, prompts: guide.prompts };
  }

  /** Bundles are looked up within the caller's workspace only: no cross-tenant sharing by hash. */
  async bundle(workspaceId: string, hash: string): Promise<string | undefined> {
    const row = await this.db.get<{ html: string }>(
      "SELECT v.html FROM versions v JOIN components co ON co.id = v.component_id WHERE co.workspace_id = ? AND v.hash = ? LIMIT 1",
      workspaceId,
      hash,
    );
    return row?.html;
  }
}
