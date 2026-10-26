import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_ENVIRONMENT, type Catalog, type CatalogComponent, type ComponentManifest, type Recipe, type Theme } from "@genui/format";
import { breakingChanges, compareSemver } from "./compat.js";

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

/** All registry data access. Every query is scoped to a workspace. */
export class Store {
  private readonly listeners = new Set<(change: EnvironmentChange) => void>();
  /** Changes made inside the open transaction, announced once it commits. */
  private pending: EnvironmentChange[] | undefined;

  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    this.pending = [];
    try {
      const result = fn();
      this.db.exec("COMMIT");
      const changes = this.pending;
      this.pending = undefined;
      for (const change of changes) this.announce(change);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pending = undefined;
      throw error;
    }
  }

  /** Calls `listener` after every committed change to what an environment serves. Returns an unsubscribe function. */
  onChange(listener: (change: EnvironmentChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(change: EnvironmentChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /** Bumps the environment's revision; listeners hear about it once the change is committed. */
  private changed(workspaceId: string, environment: string): void {
    const { revision } = this.db
      .prepare("UPDATE environments SET revision = revision + 1 WHERE workspace_id = ? AND name = ? RETURNING revision")
      .get(workspaceId, environment) as { revision: number };
    const change = { workspaceId, environment, revision };
    if (this.pending) this.pending.push(change);
    else this.announce(change);
  }

  // Workspaces and tokens

  /** Creates the workspace with its prod environment. Its public end-user MCP is on until an admin turns it off. */
  createWorkspace(name: string): string {
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare("INSERT INTO workspaces (id, name, hosted, created_at) VALUES (?, ?, 1, ?)").run(id, name, createdAt);
    this.db.prepare("INSERT INTO environments (workspace_id, name, created_at) VALUES (?, ?, ?)").run(id, DEFAULT_ENVIRONMENT, createdAt);
    return id;
  }

  countWorkspaces(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n);
  }

  workspace(workspaceId: string): { id: string; name: string } | undefined {
    return this.db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(workspaceId) as { id: string; name: string } | undefined;
  }

  /** The workspace, if the registry hosts its end-user MCP. */
  hostedWorkspace(workspaceId: string): { id: string; name: string } | undefined {
    return this.db.prepare("SELECT id, name FROM workspaces WHERE id = ? AND hosted = 1").get(workspaceId) as { id: string; name: string } | undefined;
  }

  isHosted(workspaceId: string): boolean {
    return Boolean(this.hostedWorkspace(workspaceId));
  }

  setHosted(workspaceId: string, hosted: boolean): void {
    this.db.prepare("UPDATE workspaces SET hosted = ? WHERE id = ?").run(hosted ? 1 : 0, workspaceId);
  }

  /** The secret recipe validation webhooks are signed with; created on first use. */
  webhookSecret(workspaceId: string): string {
    const row = this.db.prepare("SELECT webhook_secret FROM workspaces WHERE id = ?").get(workspaceId) as { webhook_secret: string | null } | undefined;
    return row?.webhook_secret ?? this.rotateWebhookSecret(workspaceId);
  }

  rotateWebhookSecret(workspaceId: string): string {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("UPDATE workspaces SET webhook_secret = ? WHERE id = ?").run(secret, workspaceId);
    return secret;
  }

  /** Returns the plaintext token once; only its hash is stored. `environments` limits a publish token. */
  createToken(workspaceId: string, scope: Scope, name: string, environments?: string[]): string {
    for (const environment of environments ?? []) this.requireEnvironment(workspaceId, environment);
    const token = `gnu_${scope}_${randomBytes(24).toString("base64url")}`;
    this.db
      .prepare("INSERT INTO tokens (id, workspace_id, name, scope, environments, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), workspaceId, name, scope, environments ? JSON.stringify(environments) : null, sha256(token), now());
    return token;
  }

  listTokens(workspaceId: string): TokenSummary[] {
    const rows = this.db.prepare("SELECT id, name, scope, environments, created_at FROM tokens WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as {
      id: string;
      name: string;
      scope: Scope;
      environments: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, environments: r.environments ? (JSON.parse(r.environments) as string[]) : null, createdAt: r.created_at }));
  }

  /** Servers and CI using the token get 401 from their next request. */
  revokeToken(workspaceId: string, id: string): void {
    const { changes } = this.db.prepare("DELETE FROM tokens WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
    if (!changes) throw new RegistryError(404, "No such token");
  }

  resolveToken(token: string): TokenInfo | undefined {
    const row = this.db.prepare("SELECT workspace_id, scope, environments FROM tokens WHERE hash = ?").get(sha256(token)) as
      | { workspace_id: string; scope: Scope; environments: string | null }
      | undefined;
    return row && { workspaceId: row.workspace_id, scope: row.scope, environments: row.environments ? (JSON.parse(row.environments) as string[]) : null };
  }

  // Environments

  /** The workspace's environments, prod first. */
  listEnvironments(workspaceId: string): string[] {
    const rows = this.db.prepare("SELECT name FROM environments WHERE workspace_id = ? ORDER BY name != ?, name").all(workspaceId, DEFAULT_ENVIRONMENT) as {
      name: string;
    }[];
    return rows.map((r) => r.name);
  }

  hasEnvironment(workspaceId: string, name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM environments WHERE workspace_id = ? AND name = ?").get(workspaceId, name));
  }

  /** Environments are created explicitly, so a typo fails instead of creating one. */
  requireEnvironment(workspaceId: string, name: string): void {
    if (!this.hasEnvironment(workspaceId, name)) throw new RegistryError(404, `Environment "${name}" doesn't exist. Create it with: genui env add ${name}`);
  }

  createEnvironment(workspaceId: string, name: string): void {
    if (this.hasEnvironment(workspaceId, name)) throw new RegistryError(409, `Environment "${name}" already exists`);
    this.db.prepare("INSERT INTO environments (workspace_id, name, created_at) VALUES (?, ?, ?)").run(workspaceId, name, now());
  }

  environment(workspaceId: string, name: string): EnvironmentInfo | undefined {
    const row = this.db.prepare("SELECT name, revision, refresh_url, last_refresh FROM environments WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as
      | EnvironmentRow
      | undefined;
    return row && environmentInfo(row);
  }

  /** The workspace's environments with their refresh settings, prod first. */
  listEnvironmentInfo(workspaceId: string): EnvironmentInfo[] {
    const rows = this.db
      .prepare("SELECT name, revision, refresh_url, last_refresh FROM environments WHERE workspace_id = ? ORDER BY name != ?, name")
      .all(workspaceId, DEFAULT_ENVIRONMENT) as EnvironmentRow[];
    return rows.map(environmentInfo);
  }

  /** Sets or clears (null) the URL genui calls when what the environment serves changes. */
  setRefreshUrl(workspaceId: string, name: string, url: string | null): void {
    this.requireEnvironment(workspaceId, name);
    this.db.prepare("UPDATE environments SET refresh_url = ?, last_refresh = NULL WHERE workspace_id = ? AND name = ?").run(url, workspaceId, name);
  }

  setLastRefresh(workspaceId: string, name: string, result: LastRefresh): void {
    this.db.prepare("UPDATE environments SET last_refresh = ? WHERE workspace_id = ? AND name = ?").run(JSON.stringify(result), workspaceId, name);
  }

  /** Deletes an environment with what it serves: its deployments, theme and recipes. */
  deleteEnvironment(workspaceId: string, name: string): void {
    if (name === DEFAULT_ENVIRONMENT) throw new RegistryError(400, `${DEFAULT_ENVIRONMENT} can't be deleted`);
    this.transaction(() => {
      this.requireEnvironment(workspaceId, name);
      this.db
        .prepare("DELETE FROM deployments WHERE environment = ? AND component_id IN (SELECT id FROM components WHERE workspace_id = ?)")
        .run(name, workspaceId);
      this.db.prepare("DELETE FROM recipes WHERE workspace_id = ? AND environment = ?").run(workspaceId, name);
      this.db.prepare("DELETE FROM environments WHERE workspace_id = ? AND name = ?").run(workspaceId, name);
    });
  }

  // Members (people managing a workspace through the registry MCP)

  /** Without a workspace: the one the person joined last, so an accepted invite wins over a personal workspace. */
  membership(userId: string, workspaceId?: string): Membership | undefined {
    // A deleted active environment falls back to prod.
    const select = `SELECT m.workspace_id, m.role, e.name AS environment FROM members m
      LEFT JOIN environments e ON e.workspace_id = m.workspace_id AND e.name = m.environment WHERE m.user_id = ?`;
    const row = (
      workspaceId
        ? this.db.prepare(`${select} AND m.workspace_id = ?`).get(userId, workspaceId)
        : this.db.prepare(`${select} ORDER BY m.created_at DESC LIMIT 1`).get(userId)
    ) as { workspace_id: string; role: Role; environment: string | null } | undefined;
    return row && { workspaceId: row.workspace_id, userId, role: row.role, environment: row.environment ?? DEFAULT_ENVIRONMENT };
  }

  setActiveEnvironment(workspaceId: string, userId: string, environment: string): void {
    this.requireEnvironment(workspaceId, environment);
    this.db.prepare("UPDATE members SET environment = ? WHERE workspace_id = ? AND user_id = ?").run(environment, workspaceId, userId);
  }

  addMember(workspaceId: string, userId: string, role: Role): void {
    this.db
      .prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role")
      .run(workspaceId, userId, role, now());
  }

  /** Members with the name and email they signed in with; invites still waiting for a first sign-in. */
  listMembers(workspaceId: string): { members: MemberSummary[]; invites: InviteSummary[] } {
    const members = this.db
      .prepare("SELECT m.user_id, m.role, u.name, u.email FROM members m LEFT JOIN user u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at")
      .all(workspaceId) as { user_id: string; role: Role; name: string | null; email: string | null }[];
    const invites = this.db.prepare("SELECT email, role FROM invites WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown as InviteSummary[];
    return { members: members.map((m) => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role })), invites };
  }

  cancelInvite(workspaceId: string, email: string): void {
    const { changes } = this.db.prepare("DELETE FROM invites WHERE workspace_id = ? AND email = ?").run(workspaceId, email.toLowerCase());
    if (!changes) throw new RegistryError(404, `No pending invite for ${email}`);
  }

  invite(workspaceId: string, email: string, role: Role): void {
    this.db
      .prepare("INSERT INTO invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role")
      .run(workspaceId, email.toLowerCase(), role, now());
  }

  /** Deletes a workspace nobody used: one member, nothing published, no recipes, tokens or invites. */
  private deleteIfUnused(workspaceId: string): void {
    const used = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM members WHERE workspace_id = ?) > 1
           OR EXISTS (SELECT 1 FROM components WHERE workspace_id = ?)
           OR EXISTS (SELECT 1 FROM recipes WHERE workspace_id = ?)
           OR EXISTS (SELECT 1 FROM tokens WHERE workspace_id = ?)
           OR EXISTS (SELECT 1 FROM invites WHERE workspace_id = ?) AS used`,
      )
      .get(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId) as { used: number };
    if (used.used) return;
    for (const table of ["members", "environments"]) this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  }

  /**
   * Finds or creates the signed-in person's membership:
   * pending invite → existing membership → sign-up gate → self-hosted single workspace → (hosted) a new personal workspace.
   * With `allowedEmails` set, only listed verified emails (or `@domain` entries) get past the gate; the rest get no
   * membership until someone invites them.
   */
  resolveMembership(
    user: { id: string; email: string; emailVerified: boolean; name?: string },
    options: { mode: "hosted" | "self-hosted"; adminEmails: string[]; allowedEmails?: string[] },
  ): Membership | undefined {
    return this.transaction(() => {
      // Invites and admin emails grant access by email, so only a verified email (GitHub, Google,
      // company IdP) may claim them. Unverified password sign-ups never match.
      const email = user.emailVerified ? user.email.toLowerCase() : undefined;
      const invite = email
        ? (this.db.prepare("SELECT workspace_id, role FROM invites WHERE email = ? ORDER BY created_at LIMIT 1").get(email) as
            | { workspace_id: string; role: Role }
            | undefined)
        : undefined;
      // An invite wins even for people who already have a workspace, e.g. one made at an earlier sign-in.
      if (invite && email) {
        const previous = this.membership(user.id);
        this.addMember(invite.workspace_id, user.id, invite.role);
        this.db.prepare("DELETE FROM invites WHERE workspace_id = ? AND email = ?").run(invite.workspace_id, email);
        if (previous && previous.workspaceId !== invite.workspace_id) this.deleteIfUnused(previous.workspaceId);
        return this.membership(user.id, invite.workspace_id);
      }

      const existing = this.membership(user.id);
      if (existing) return existing;

      const allowed = options.allowedEmails ?? [];
      if (allowed.length > 0) {
        const listed = email !== undefined && (allowed.includes(email) || allowed.includes(email.slice(email.lastIndexOf("@"))));
        if (!listed && !(email !== undefined && options.adminEmails.includes(email))) return undefined;
      }

      if (options.mode === "self-hosted") {
        const workspace = this.db.prepare("SELECT id FROM workspaces ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
        if (!workspace) return undefined;
        const hasAdmin = this.db.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND role = 'admin'").get(workspace.id);
        // Whoever can sign in through the company IdP may manage. Admins: the listed (verified) emails;
        // only when no list is configured, the first person to sign in.
        const listed = email !== undefined && options.adminEmails.includes(email);
        const firstPerson = !hasAdmin && options.adminEmails.length === 0;
        const role: Role = listed || firstPerson ? "admin" : "member";
        this.addMember(workspace.id, user.id, role);
        return this.membership(user.id, workspace.id);
      }

      const workspaceId = this.createWorkspace(`${user.name || user.email}'s workspace`);
      this.addMember(workspaceId, user.id, "admin");
      return this.membership(user.id, workspaceId);
    });
  }

  // Recipes: per environment, live in that environment on save.

  listRecipes(workspaceId: string, environment: string): Recipe[] {
    const rows = this.db.prepare("SELECT recipe FROM recipes WHERE workspace_id = ? AND environment = ? ORDER BY name").all(workspaceId, environment) as {
      recipe: string;
    }[];
    return rows.map((r) => JSON.parse(r.recipe) as Recipe);
  }

  getRecipe(workspaceId: string, environment: string, name: string): Recipe | undefined {
    const row = this.db.prepare("SELECT recipe FROM recipes WHERE workspace_id = ? AND environment = ? AND name = ?").get(workspaceId, environment, name) as
      | { recipe: string }
      | undefined;
    return row ? (JSON.parse(row.recipe) as Recipe) : undefined;
  }

  /** Creates or replaces a recipe. Returns true when it replaced an existing one. */
  saveRecipe(workspaceId: string, environment: string, recipe: Recipe): boolean {
    this.requireEnvironment(workspaceId, environment);
    const existed = Boolean(this.getRecipe(workspaceId, environment, recipe.name));
    this.db
      .prepare(
        "INSERT INTO recipes (workspace_id, environment, name, recipe, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, environment, name) DO UPDATE SET recipe = excluded.recipe, updated_at = excluded.updated_at",
      )
      .run(workspaceId, environment, recipe.name, JSON.stringify(recipe), now());
    this.changed(workspaceId, environment);
    return existed;
  }

  deleteRecipe(workspaceId: string, environment: string, name: string): void {
    const result = this.db.prepare("DELETE FROM recipes WHERE workspace_id = ? AND environment = ? AND name = ?").run(workspaceId, environment, name);
    if (!result.changes) throw new RegistryError(404, `Recipe "${name}" not found in ${environment}`);
    this.changed(workspaceId, environment);
  }

  // Theme: per environment.

  getTheme(workspaceId: string, environment: string): Theme | null {
    const row = this.db.prepare("SELECT theme FROM environments WHERE workspace_id = ? AND name = ?").get(workspaceId, environment) as
      | { theme: string | null }
      | undefined;
    return row?.theme ? (JSON.parse(row.theme) as Theme) : null;
  }

  setTheme(workspaceId: string, environment: string, theme: Theme | null): void {
    this.requireEnvironment(workspaceId, environment);
    this.db.prepare("UPDATE environments SET theme = ? WHERE workspace_id = ? AND name = ?").run(theme ? JSON.stringify(theme) : null, workspaceId, environment);
    this.changed(workspaceId, environment);
  }

  // Components

  private componentId(workspaceId: string, name: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM components WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as { id: string } | undefined;
    return row?.id;
  }

  private requireComponent(workspaceId: string, name: string): string {
    const id = this.componentId(workspaceId, name);
    if (!id) throw new RegistryError(404, `Component "${name}" not found`);
    return id;
  }

  /** Points an environment at a version and reports what changed. */
  private deploy(
    workspaceId: string,
    componentId: string,
    environment: string,
    versionId: string,
    result: Pick<PublishResult, "version" | "hash" | "created">,
  ): PublishResult {
    const manifest = JSON.parse((this.db.prepare("SELECT manifest FROM versions WHERE id = ?").get(versionId) as { manifest: string }).manifest) as ComponentManifest;
    const current = this.db
      .prepare("SELECT d.version_id, v.version, v.manifest FROM deployments d JOIN versions v ON v.id = d.version_id WHERE d.component_id = ? AND d.environment = ?")
      .get(componentId, environment) as { version_id: string; version: string; manifest: string } | undefined;
    // Breaking props only warn: which version an environment serves is the publisher's call.
    const warnings = current
      ? breakingChanges((JSON.parse(current.manifest) as ComponentManifest).props, manifest.props).map((issue) => `${issue} (${environment} served ${current.version})`)
      : [];
    // A re-run CI job points the environment at what it already serves: nothing changes.
    if (current?.version_id !== versionId) {
      this.db
        .prepare(
          "INSERT INTO deployments (component_id, environment, version_id) VALUES (?, ?, ?) ON CONFLICT (component_id, environment) DO UPDATE SET version_id = excluded.version_id",
        )
        .run(componentId, environment, versionId);
      this.changed(workspaceId, environment);
    }
    return { ...result, environment, environments: this.deployedVersions(componentId), warnings };
  }

  private deployedVersions(componentId: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT d.environment, v.version FROM deployments d JOIN versions v ON v.id = d.version_id WHERE d.component_id = ? ORDER BY d.environment != ?, d.environment")
      .all(componentId, DEFAULT_ENVIRONMENT) as { environment: string; version: string }[];
    return Object.fromEntries(rows.map((r) => [r.environment, r.version]));
  }

  /**
   * Publishes an immutable version and points the environment at it, older versions included. Publishing
   * the same version with the same bundle and manifest again only points the environment, so CI jobs can be re-run.
   */
  publish(workspaceId: string, manifest: ComponentManifest, html: string, environment: string = DEFAULT_ENVIRONMENT): PublishResult {
    return this.transaction(() => {
      this.requireEnvironment(workspaceId, environment);
      let componentId = this.componentId(workspaceId, manifest.name);
      if (!componentId) {
        componentId = randomUUID();
        this.db.prepare("INSERT INTO components (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").run(componentId, workspaceId, manifest.name, now());
      }
      const hash = sha256(html).slice(0, 16);

      const same = this.db.prepare("SELECT id, hash, manifest FROM versions WHERE component_id = ? AND version = ?").get(componentId, manifest.version) as
        | { id: string; hash: string; manifest: string }
        | undefined;
      if (same) {
        if (same.hash !== hash || same.manifest !== JSON.stringify(manifest)) {
          throw new RegistryError(
            409,
            `${manifest.name}@${manifest.version} already exists with different content; versions are immutable. To serve it here without rebuilding: genui publish ${manifest.name}@${manifest.version} --env ${environment}`,
          );
        }
        return this.deploy(workspaceId, componentId, environment, same.id, { version: manifest.version, hash, created: false });
      }

      const versionId = randomUUID();
      this.db
        .prepare("INSERT INTO versions (id, component_id, version, hash, manifest, html, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(versionId, componentId, manifest.version, hash, JSON.stringify(manifest), html, now());
      return this.deploy(workspaceId, componentId, environment, versionId, { version: manifest.version, hash, created: true });
    });
  }

  /** Points an environment at a version that's already published: the same bundle, no rebuild. */
  deployVersion(workspaceId: string, name: string, version: string, environment: string): PublishResult {
    return this.transaction(() => {
      this.requireEnvironment(workspaceId, environment);
      const componentId = this.requireComponent(workspaceId, name);
      const row = this.db.prepare("SELECT id, hash FROM versions WHERE component_id = ? AND version = ?").get(componentId, version) as
        | { id: string; hash: string }
        | undefined;
      if (!row) throw new RegistryError(404, `${name}@${version} isn't published`);
      return this.deploy(workspaceId, componentId, environment, row.id, { version, hash: row.hash, created: false });
    });
  }

  listComponents(workspaceId: string): ComponentSummary[] {
    const components = this.db.prepare("SELECT id, name FROM components WHERE workspace_id = ? ORDER BY name").all(workspaceId) as { id: string; name: string }[];
    return components.map(({ id, name }) => {
      const versions = (this.db.prepare("SELECT version FROM versions WHERE component_id = ?").all(id) as { version: string }[])
        .map((r) => r.version)
        .sort((a, b) => compareSemver(b, a));
      return { name, environments: this.deployedVersions(id), versions };
    });
  }

  catalog(workspaceId: string, environment: string): Catalog {
    const rows = this.db
      .prepare(
        `SELECT co.name, v.version, v.hash, v.manifest FROM deployments d
         JOIN components co ON co.id = d.component_id
         JOIN versions v ON v.id = d.version_id
         WHERE co.workspace_id = ? AND d.environment = ? ORDER BY co.name`,
      )
      .all(workspaceId, environment) as { name: string; version: string; hash: string; manifest: string }[];
    const components: CatalogComponent[] = rows.map((r) => ({ name: r.name, version: r.version, hash: r.hash, manifest: JSON.parse(r.manifest) }));
    return { environment, theme: this.getTheme(workspaceId, environment), components, recipes: this.listRecipes(workspaceId, environment) };
  }

  /** Bundles are looked up within the caller's workspace only: no cross-tenant sharing by hash. */
  bundle(workspaceId: string, hash: string): string | undefined {
    const row = this.db
      .prepare("SELECT v.html FROM versions v JOIN components co ON co.id = v.component_id WHERE co.workspace_id = ? AND v.hash = ? LIMIT 1")
      .get(workspaceId, hash) as { html: string } | undefined;
    return row?.html;
  }
}
