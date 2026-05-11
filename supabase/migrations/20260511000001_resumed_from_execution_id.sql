-- Distinguish resume from replay on workflow_executions.
--
-- Both replay and resume currently set parent_execution_id, which means the
-- API can't tell them apart from the row alone. Resumes need the canvas
-- overlay to inherit step outputs from the parent execution (so skipped
-- upstream steps still show their results); replays don't.
--
-- This adds a separate resumed_from_execution_id column. The engine writes
-- both columns for resumes (parent_execution_id stays populated so the
-- existing UI replay-lineage indicator keeps working) and only
-- parent_execution_id for replays.

ALTER TABLE workflow_executions
ADD COLUMN resumed_from_execution_id UUID;

CREATE INDEX idx_workflow_executions_resumed_from
ON workflow_executions(resumed_from_execution_id)
WHERE resumed_from_execution_id IS NOT NULL;
