-- How the end-user MCP presents itself to hosts (serverInfo): per workspace. title, description and
-- website_url are optional; icon is the uploaded image, base64, with its media type and content hash.
ALTER TABLE workspaces ADD COLUMN title TEXT;
ALTER TABLE workspaces ADD COLUMN description TEXT;
ALTER TABLE workspaces ADD COLUMN website_url TEXT;
ALTER TABLE workspaces ADD COLUMN icon TEXT;
ALTER TABLE workspaces ADD COLUMN icon_type TEXT;
ALTER TABLE workspaces ADD COLUMN icon_hash TEXT;

-- How the model should use an environment's MCP: server instructions and workflow prompts (JSON list).
-- Saved like the theme, with a revision bump.
ALTER TABLE environments ADD COLUMN instructions TEXT;
ALTER TABLE environments ADD COLUMN prompts TEXT;
