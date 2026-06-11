-- HTTP status of the response an execution actually returned (issue #30).
--
-- workflow_executions.response_body only ever stores the response BODY; the
-- admin sightings backfill derived response_status_code from a status_code
-- field inside it, which is never there, so backfilled sightings always got
-- null and deriveRejectReason could not classify >=500 responses as
-- engine_error. The engine now persists the real status at finalize (the same
-- walkStatus the live sightings path uses); the backfill reads this column.
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS response_status INTEGER;
