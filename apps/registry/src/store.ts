import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Catalog, CatalogComponent, Channel, ComponentManifest, Recipe, Theme } from "@genui/format";
import { breakingChanges, compareSemver, parseSemver } from "./compat.js";

export type Scope = "server" | "publish" | "release" | "admin";
export type Role = "member" | "admin";

export interface Membership {
  workspaceId: string;
  role: Role;
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

export interface ComponentSummary {
  name: string;
  channels: Partial<Record<Channel, string>>;
  versions: string[];
}

/** All registry data access. Every query is scoped to a workspace. */
export class Store {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Workspaces and tokens

  createWorkspace(name: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
    return id;
  }

  countWorkspaces(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n);
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

  /** Returns the plaintext token once; only its hash is stored. */
  createToken(workspaceId: string, scope: Scope, name: string): string {
    const token = `gnu_${scope}_${randomBytes(24).toString("base64url")}`;
    this.db
      .prepare("INSERT INTO tokens (id, workspace_id, name, scope, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), workspaceId, name, scope, sha256(token), now());
    return token;
  }

  resolveToken(token: string): { workspaceId: string; scope: Scope } | undefined {
    const row = this.db.prepare("SELECT workspace_id, scope FROM tokens WHERE hash = ?").get(sha256(token)) as
      | { workspace_id: string; scope: Scope }
      | undefined;
    return row && { workspaceId: row.workspace_id, scope: row.scope };
  }

  // Members (people managing a workspace through the registry MCP)

  membership(userId: string, workspaceId?: string): Membership | undefined {
    const row = (
      workspaceId
        ? this.db.prepare("SELECT workspace_id, role FROM members WHERE user_id = ? AND workspace_id = ?").get(userId, workspaceId)
        : this.db.prepare("SELECT workspace_id, role FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1").get(userId)
    ) as { workspace_id: string; role: Role } | undefined;
    return row && { workspaceId: row.workspace_id, role: row.role };
  }

  addMember(workspaceId: string, userId: string, role: Role): void {
    this.db
      .prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role")
      .run(workspaceId, userId, role, now());
  }

  invite(workspaceId: string, email: string, role: Role): void {
    this.db
      .prepare("INSERT INTO invites (workspace_id, email, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role")
      .run(workspaceId, email.toLowerCase(), role, now());
  }

  /**
   * Finds or creates the signed-in person's membership:
   * existing membership → pending invite → self-hosted single workspace → (hosted) a new personal workspace.
   */
  resolveMembership(
    user: { id: string; email: string; emailVerified: boolean; name?: string },
    options: { mode: "hosted" | "self-hosted"; adminEmails: string[] },
  ): Membership | undefined {
    return this.transaction(() => {
      const existing = this.membership(user.id);
      if (existing) return existing;

      // Invites and admin emails grant access by email, so only a verified email (GitHub, Google,
      // company IdP) may claim them. Unverified password sign-ups never match.
      const email = user.emailVerified ? user.email.toLowerCase() : undefined;
      const invite = email
        ? (this.db.prepare("SELECT workspace_id, role FROM invites WHERE email = ? ORDER BY created_at LIMIT 1").get(email) as
            | { workspace_id: string; role: Role }
            | undefined)
        : undefined;
      if (invite && email) {
        this.addMember(invite.workspace_id, user.id, invite.role);
        this.db.prepare("DELETE FROM invites WHERE workspace_id = ? AND email = ?").run(invite.workspace_id, email);
        return { workspaceId: invite.workspace_id, role: invite.role };
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
        return { workspaceId: workspace.id, role };
      }

      const workspaceId = this.createWorkspace(`${user.name || user.email}'s workspace`);
      this.addMember(workspaceId, user.id, "admin");
      return { workspaceId, role: "admin" };
    });
  }

  // Recipes

  listRecipes(workspaceId: string): Recipe[] {
    const rows = this.db.prepare("SELECT recipe FROM recipes WHERE workspace_id = ? ORDER BY name").all(workspaceId) as { recipe: string }[];
    return rows.map((r) => JSON.parse(r.recipe) as Recipe);
  }

  getRecipe(workspaceId: string, name: string): Recipe | undefined {
    const row = this.db.prepare("SELECT recipe FROM recipes WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as { recipe: string } | undefined;
    return row ? (JSON.parse(row.recipe) as Recipe) : undefined;
  }

  /** Creates or replaces a recipe. Returns true when it replaced an existing one. */
  saveRecipe(workspaceId: string, recipe: Recipe): boolean {
    const existed = Boolean(this.getRecipe(workspaceId, recipe.name));
    this.db
      .prepare(
        "INSERT INTO recipes (workspace_id, name, recipe, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, name) DO UPDATE SET recipe = excluded.recipe, updated_at = excluded.updated_at",
      )
      .run(workspaceId, recipe.name, JSON.stringify(recipe), now());
    return existed;
  }

  deleteRecipe(workspaceId: string, name: string): void {
    const result = this.db.prepare("DELETE FROM recipes WHERE workspace_id = ? AND name = ?").run(workspaceId, name);
    if (!result.changes) throw new RegistryError(404, `Recipe "${name}" not found`);
  }

  // Theme

  getTheme(workspaceId: string): Theme | null {
    const row = this.db.prepare("SELECT theme FROM workspaces WHERE id = ?").get(workspaceId) as { theme: string | null } | undefined;
    return row?.theme ? (JSON.parse(row.theme) as Theme) : null;
  }

  setTheme(workspaceId: string, theme: Theme | null): void {
    this.db.prepare("UPDATE workspaces SET theme = ? WHERE id = ?").run(theme ? JSON.stringify(theme) : null, workspaceId);
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

  private setChannel(componentId: string, channel: Channel, versionId: string): void {
    const current = this.db.prepare("SELECT version_id FROM channels WHERE component_id = ? AND channel = ?").get(componentId, channel) as
      | { version_id: string }
      | undefined;
    if (current?.version_id === versionId) return; // no-op: keeps rollback history meaningful
    this.db
      .prepare(
        "INSERT INTO channels (component_id, channel, version_id) VALUES (?, ?, ?) ON CONFLICT (component_id, channel) DO UPDATE SET version_id = excluded.version_id",
      )
      .run(componentId, channel, versionId);
    this.db
      .prepare("INSERT INTO channel_history (component_id, channel, version_id, changed_at) VALUES (?, ?, ?, ?)")
      .run(componentId, channel, versionId, now());
  }

  /** Points a channel at a version unless it already points at a newer one: publishing never moves a channel back. */
  private advanceChannel(componentId: string, channel: Channel, versionId: string, version: string): void {
    const current = this.db
      .prepare("SELECT v.version FROM channels c JOIN versions v ON v.id = c.version_id WHERE c.component_id = ? AND c.channel = ?")
      .get(componentId, channel) as { version: string } | undefined;
    if (current && compareSemver(current.version, version) > 0) return;
    this.setChannel(componentId, channel, versionId);
  }

  private channelVersions(componentId: string): Partial<Record<Channel, string>> {
    const rows = this.db
      .prepare("SELECT c.channel, v.version FROM channels c JOIN versions v ON v.id = c.version_id WHERE c.component_id = ?")
      .all(componentId) as { channel: Channel; version: string }[];
    return Object.fromEntries(rows.map((r) => [r.channel, r.version]));
  }

  /**
   * Publishes an immutable version and points `beta` at it (with `stable`, both). Publishing the same
   * version with the same bundle and manifest again only advances the channels, so CI jobs can be re-run.
   */
  publish(
    workspaceId: string,
    manifest: ComponentManifest,
    html: string,
    channel: Channel = "beta",
  ): { version: string; hash: string; created: boolean; channels: Partial<Record<Channel, string>> } {
    return this.transaction(() => {
      let componentId = this.componentId(workspaceId, manifest.name);
      if (!componentId) {
        componentId = randomUUID();
        this.db.prepare("INSERT INTO components (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").run(componentId, workspaceId, manifest.name, now());
      }
      // Beta is never behind stable: a release lands on both.
      const targets: Channel[] = channel === "stable" ? ["beta", "stable"] : ["beta"];
      const hash = sha256(html).slice(0, 16);

      const existing = this.db.prepare("SELECT id, version, hash, manifest FROM versions WHERE component_id = ?").all(componentId) as {
        id: string;
        version: string;
        hash: string;
        manifest: string;
      }[];
      const same = existing.find((v) => v.version === manifest.version);
      if (same) {
        if (same.hash !== hash || same.manifest !== JSON.stringify(manifest)) {
          throw new RegistryError(409, `${manifest.name}@${manifest.version} already exists with different content; versions are immutable`);
        }
        for (const target of targets) this.advanceChannel(componentId, target, same.id, same.version);
        return { version: manifest.version, hash, created: false, channels: this.channelVersions(componentId) };
      }
      const latest = existing.sort((a, b) => compareSemver(b.version, a.version))[0];
      if (latest) {
        if (compareSemver(manifest.version, latest.version) <= 0) {
          throw new RegistryError(409, `Version ${manifest.version} must be greater than the latest (${latest.version})`);
        }
        const previous = JSON.parse(latest.manifest) as ComponentManifest;
        const issues = breakingChanges(previous.props, manifest.props);
        if (issues.length && parseSemver(manifest.version)[0] === parseSemver(latest.version)[0]) {
          throw new RegistryError(409, `Breaking props change (${issues.join(", ")}) requires a major version bump`);
        }
      }

      const versionId = randomUUID();
      this.db
        .prepare("INSERT INTO versions (id, component_id, version, hash, manifest, html, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(versionId, componentId, manifest.version, hash, JSON.stringify(manifest), html, now());
      for (const target of targets) this.setChannel(componentId, target, versionId);
      return { version: manifest.version, hash, created: true, channels: this.channelVersions(componentId) };
    });
  }

  /** Points `stable` at a version (default: the current beta). */
  promote(workspaceId: string, name: string, version?: string): string {
    return this.transaction(() => {
      const componentId = this.requireComponent(workspaceId, name);
      const row = version
        ? (this.db.prepare("SELECT id, version FROM versions WHERE component_id = ? AND version = ?").get(componentId, version) as { id: string; version: string } | undefined)
        : (this.db
            .prepare("SELECT v.id, v.version FROM channels c JOIN versions v ON v.id = c.version_id WHERE c.component_id = ? AND c.channel = 'beta'")
            .get(componentId) as { id: string; version: string } | undefined);
      if (!row) throw new RegistryError(404, version ? `Version ${version} not found` : "Nothing on beta to promote");
      this.setChannel(componentId, "stable", row.id);
      return row.version;
    });
  }

  /** Moves a channel back to its previous version. */
  rollback(workspaceId: string, name: string, channel: Channel): string {
    return this.transaction(() => {
      const componentId = this.requireComponent(workspaceId, name);
      const history = this.db
        .prepare("SELECT id, version_id FROM channel_history WHERE component_id = ? AND channel = ? ORDER BY id DESC LIMIT 2")
        .all(componentId, channel) as { id: number; version_id: string }[];
      const [current, previous] = history;
      if (!current || !previous) throw new RegistryError(409, `No previous ${channel} version to roll back to`);
      this.db.prepare("DELETE FROM channel_history WHERE id = ?").run(current.id);
      this.db.prepare("UPDATE channels SET version_id = ? WHERE component_id = ? AND channel = ?").run(previous.version_id, componentId, channel);
      const row = this.db.prepare("SELECT version FROM versions WHERE id = ?").get(previous.version_id) as { version: string };
      return row.version;
    });
  }

  listComponents(workspaceId: string): ComponentSummary[] {
    const components = this.db.prepare("SELECT id, name FROM components WHERE workspace_id = ? ORDER BY name").all(workspaceId) as { id: string; name: string }[];
    return components.map(({ id, name }) => {
      const channels = this.channelVersions(id);
      const versions = (this.db.prepare("SELECT version FROM versions WHERE component_id = ?").all(id) as { version: string }[])
        .map((r) => r.version)
        .sort((a, b) => compareSemver(b, a));
      return { name, channels, versions };
    });
  }

  catalog(workspaceId: string, channel: Channel): Catalog {
    const rows = this.db
      .prepare(
        `SELECT co.name, v.version, v.hash, v.manifest FROM channels c
         JOIN components co ON co.id = c.component_id
         JOIN versions v ON v.id = c.version_id
         WHERE co.workspace_id = ? AND c.channel = ? ORDER BY co.name`,
      )
      .all(workspaceId, channel) as { name: string; version: string; hash: string; manifest: string }[];
    const components: CatalogComponent[] = rows.map((r) => ({ name: r.name, version: r.version, hash: r.hash, manifest: JSON.parse(r.manifest) }));
    return { channel, theme: this.getTheme(workspaceId), components, recipes: this.listRecipes(workspaceId) };
  }

  /** Bundles are looked up within the caller's workspace only: no cross-tenant sharing by hash. */
  bundle(workspaceId: string, hash: string): string | undefined {
    const row = this.db
      .prepare("SELECT v.html FROM versions v JOIN components co ON co.id = v.component_id WHERE co.workspace_id = ? AND v.hash = ? LIMIT 1")
      .get(workspaceId, hash) as { html: string } | undefined;
    return row?.html;
  }
}
