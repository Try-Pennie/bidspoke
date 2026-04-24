-- Make execution_steps → workflow_executions FK cascade on delete.
-- Previously RESTRICT, which forced a two-step delete (steps first, then executions)
-- for ad-hoc pruning. Steps have no meaning without their execution, so cascade
-- is the correct semantic. Workflow-level safety is still enforced by the
-- workflow_executions → workflows FK (RESTRICT), which preserves soft-delete history.

ALTER TABLE execution_steps
  DROP CONSTRAINT execution_steps_execution_fk;

ALTER TABLE execution_steps
  ADD CONSTRAINT execution_steps_execution_fk
  FOREIGN KEY (execution_id, execution_started_at)
  REFERENCES workflow_executions(id, started_at)
  ON DELETE CASCADE;
