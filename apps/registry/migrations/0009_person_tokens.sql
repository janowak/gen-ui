-- `app-mcp login` signs a person in, not a workspace: the token reaches every workspace they're in, with
-- their role in each, read on every request. Like a chat-made token, it has no secret (NULL hash) until
-- the CLI trades its one-time code for it.
CREATE TABLE person_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX person_tokens_user ON person_tokens (user_id);
