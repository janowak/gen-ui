-- A workspace's end-user MCP lives at /w/<slug>/mcp, a handle made from its name, instead of its id.
-- Existing workspaces get their name lowercased with spaces as dashes; a name that doesn't make a valid
-- slug keeps its id, and a later duplicate gets a short suffix. Admins change it with workspace_rename.
ALTER TABLE workspaces ADD COLUMN slug TEXT;
UPDATE workspaces SET slug = trim(replace(replace(replace(lower(trim(name)), '''', ''), '’', ''), ' ', '-'), '-');
UPDATE workspaces SET slug = id
  WHERE slug = '' OR length(slug) > 40 OR slug GLOB '*[^a-z0-9-]*' OR slug GLOB '*--*';
UPDATE workspaces SET slug = slug || '-' || substr(id, 1, 4)
  WHERE EXISTS (
    SELECT 1 FROM workspaces o
    WHERE o.slug = workspaces.slug AND (o.created_at < workspaces.created_at OR (o.created_at = workspaces.created_at AND o.id < workspaces.id))
  );
CREATE UNIQUE INDEX workspaces_slug ON workspaces (slug);
