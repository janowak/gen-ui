-- Whether an environment's end-user MCP offers genui's built-in render_form and render_chart.
-- Off: only the workspace's own components and recipes (recipes still render with the form view).
ALTER TABLE environments ADD COLUMN built_ins INTEGER NOT NULL DEFAULT 1;
