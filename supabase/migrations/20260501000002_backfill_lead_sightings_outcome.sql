-- One-shot backfill of lead_sightings.outcome from workflow_executions.outcome.
-- Joins on (execution_id, started_at) since both tables are partitioned and
-- the FK is composite. Only updates rows where outcome is currently null.

UPDATE lead_sightings ls
SET outcome = we.outcome
FROM workflow_executions we
WHERE ls.execution_id = we.id
  AND ls.execution_started_at_utc = we.started_at AT TIME ZONE 'UTC'
  AND ls.outcome IS NULL;
