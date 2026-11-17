-- One login can be in several workspaces. The one with the highest rank is active: the web console shows
-- it and the CLI and connector pages preselect it. Joining or switching to a workspace ranks it highest.
-- A counter rather than a time, so two changes in the same millisecond still order.
ALTER TABLE members ADD COLUMN active_rank INTEGER;
