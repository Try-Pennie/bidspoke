-- Stable node identifiers for log/outcome rows so renames in the canvas don't
-- invalidate historical queries. node.id is already a UUID generated at drop
-- time on the canvas; lead_sightings.terminal_node_id has stored it from day
-- one. Closing the gap on execution_steps + workflow_executions.

ALTER TABLE execution_steps
  ADD COLUMN step_node_id UUID;

ALTER TABLE workflow_executions
  ADD COLUMN final_node_id UUID;

CREATE INDEX IF NOT EXISTS idx_execution_steps_node_id
  ON execution_steps (step_node_id)
  WHERE step_node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_executions_final_node_id
  ON workflow_executions (final_node_id)
  WHERE final_node_id IS NOT NULL;
