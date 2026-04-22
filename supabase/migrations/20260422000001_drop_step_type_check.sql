-- The app-side NodeType union is the source of truth for step types.
-- The DB-level CHECK was stale (missing constants/salesforce/parallel_end/webhook),
-- causing every row for those types to be silently rejected — rows never landed,
-- executions displayed as "not reached", and debug time was wasted chasing a UI bug.
ALTER TABLE execution_steps
  DROP CONSTRAINT IF EXISTS execution_steps_step_type_check;
