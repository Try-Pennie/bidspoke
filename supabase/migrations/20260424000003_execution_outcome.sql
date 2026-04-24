-- Execution outcome: user-defined success classification.
-- `outcome` refines the existing `status` column.
--   - 'successful': the walk ended on a node the workflow's trigger config
--     listed in success_node_namespaces.
--   - 'completed':  the walk ended cleanly but not on a success node (or no
--     success nodes are configured).
--   - 'failed':     a step threw.
-- `final_node_namespace` records where the walk terminated so we can show
-- ops the actual exit point and re-derive outcome if the config changes.

ALTER TABLE workflow_executions
  ADD COLUMN outcome TEXT,
  ADD COLUMN final_node_namespace TEXT;

-- Backfill existing rows from status (running stays null on outcome).
UPDATE workflow_executions
  SET outcome = CASE
    WHEN status = 'failed'    THEN 'failed'
    WHEN status = 'completed' THEN 'completed'
    WHEN status = 'exited'    THEN 'completed'
    ELSE NULL
  END
  WHERE outcome IS NULL;

CREATE INDEX workflow_executions_outcome_idx
  ON workflow_executions (workflow_id, outcome, started_at DESC)
  WHERE outcome IS NOT NULL;
