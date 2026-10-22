import { DatabaseSync } from "node:sqlite";

/**
 * SQLite schema. Every row is scoped to a workspace: the cloud runs many,
 * a self-hosted install usually one. Versions are immutable; channels are pointers.
 */
const MIGRATIONS = [
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    theme TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('server', 'publish', 'admin')),
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE components (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, name)
  );
  CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL REFERENCES components(id),
    version TEXT NOT NULL,
    hash TEXT NOT NULL,
    manifest TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (component_id, version)
  );
  CREATE INDEX versions_hash ON versions(hash);
  CREATE TABLE channels (
    component_id TEXT NOT NULL REFERENCES components(id),
    channel TEXT NOT NULL CHECK (channel IN ('beta', 'stable')),
    version_id TEXT NOT NULL REFERENCES versions(id),
    PRIMARY KEY (component_id, channel)
  );
  -- Every pointer change, newest last; rollback pops the latest entry.
  CREATE TABLE channel_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component_id TEXT NOT NULL REFERENCES components(id),
    channel TEXT NOT NULL,
    version_id TEXT NOT NULL REFERENCES versions(id),
    changed_at TEXT NOT NULL
  );
  `,
  `
  -- People who manage a workspace. user_id is the better-auth user id.
  CREATE TABLE members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);
  -- Pending memberships, claimed when someone with that email first signs in.
  CREATE TABLE invites (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, email)
  );
  `,
  `
  -- Named, business-owned forms. Saving one makes it live (no channels yet).
  CREATE TABLE recipes (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    recipe TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, name)
  );
  `,
  `
  -- Release tokens: publish to any channel, promote, roll back. SQLite cannot alter a CHECK, so rebuild.
  CREATE TABLE tokens_next (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('server', 'publish', 'release', 'admin')),
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  INSERT INTO tokens_next SELECT id, workspace_id, name, scope, hash, created_at FROM tokens;
  DROP TABLE tokens;
  ALTER TABLE tokens_next RENAME TO tokens;
  `,
  `
  -- Hosted MCP: the registry serves the workspace's end-user MCP at /w/<id>/mcp. Off until an admin turns it on.
  ALTER TABLE workspaces ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Signs requests to recipe validation webhooks. Kept in plain text: signing needs the secret itself.
  ALTER TABLE workspaces ADD COLUMN webhook_secret TEXT;
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}
