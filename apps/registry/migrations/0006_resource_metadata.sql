-- CSP and rendering metadata are immutable alongside each component shell.
ALTER TABLE versions ADD COLUMN resource_meta TEXT;
-- Original build identity preserves idempotent publishing across delivery modes and URL changes.
ALTER TABLE versions ADD COLUMN source_hash TEXT;
