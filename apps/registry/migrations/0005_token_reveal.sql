-- A token made in chat has no secret until an admin reveals it in the tokens view, so the model never sees one.
-- Until then its hash is NULL and it authenticates nothing. SQLite can't drop NOT NULL in place: rebuild the table.
CREATE TABLE tokens_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('server', 'publish', 'admin')),
  environments TEXT,
  hash TEXT UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO tokens_next (id, workspace_id, name, scope, environments, hash, created_at)
  SELECT id, workspace_id, name, scope, environments, hash, created_at FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_next RENAME TO tokens;
