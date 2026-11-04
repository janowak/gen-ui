-- The registry's tables. Every row is scoped to a workspace: the cloud runs many, a self-hosted install
-- usually one. Versions are immutable; deployments point an environment at one.

-- hosted: the workspace's end-user MCP is public (no server token needed).
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hosted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Each environment serves exactly what was last published or saved to it: component versions, its theme
-- and its workflows. Every workspace has prod. Every change bumps the revision, which the SDK compares to know
-- when to re-list; a company's server can register a refresh URL that app-mcp calls on each change.
CREATE TABLE environments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  theme TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  refresh_url TEXT,
  last_refresh TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

-- Only the hash is stored. Publish tokens can be limited to environments (JSON list; null: all).
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('server', 'publish', 'admin')),
  environments TEXT,
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

CREATE TABLE deployments (
  component_id TEXT NOT NULL REFERENCES components(id),
  environment TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES versions(id),
  PRIMARY KEY (component_id, environment)
);

-- People who manage a workspace. user_id is the better-auth user id. environment: what the person's
-- previews, theme, instructions and workflows show in the management MCP (null: prod).
CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  environment TEXT,
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

-- Playbooks for the model, per environment: with params a slash command, without part of the instructions.
CREATE TABLE workflows (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  environment TEXT NOT NULL,
  name TEXT NOT NULL,
  workflow TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, environment, name)
);
