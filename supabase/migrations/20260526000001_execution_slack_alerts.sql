-- Persist per-execution Slack alert metadata so the execution detail page can
-- show a "what went wrong" banner that stays accurate even after the workflow's
-- duration threshold changes. Recomputing from the current trigger config would
-- lie about historical runs.
--
-- slack_alert_reason JSONB holds a snapshot:
--   { step_namespace, step_type, step_duration_ms,
--     threshold_ms?, error_message?, error_type?,
--     summary?, slack_ts? }
-- summary is filled in asynchronously by a Claude call after the alert fires.

ALTER TABLE workflow_executions
ADD COLUMN slack_alert_type TEXT,
ADD COLUMN slack_alert_fired_at TIMESTAMPTZ,
ADD COLUMN slack_alert_reason JSONB;
