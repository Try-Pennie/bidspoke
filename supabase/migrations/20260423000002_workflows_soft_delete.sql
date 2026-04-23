-- Soft-delete workflows. The original FK on workflow_executions.workflow_id is
-- ON DELETE NO ACTION (partitioned table, cascading across monthly partitions
-- is fragile), so hard-deleting a workflow with any execution history fails.
-- Execution rows are audit + cost history — we want to keep them even when a
-- workflow is retired. List queries filter out deleted_at IS NOT NULL.
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workflows_org_active_idx
  ON workflows (organization_id)
  WHERE deleted_at IS NULL;
