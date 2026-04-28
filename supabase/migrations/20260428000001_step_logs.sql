-- Capture console output from code-node scripts on each step row.
-- Populated by the engine when the bundled code worker returns a {__bsv: 1, output, logs}
-- envelope. Existing rows stay null; older bundles that return bare output
-- continue to work without logs until the workflow is saved (which redeploys
-- the bundle in the new envelope format).

ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS logs jsonb;
