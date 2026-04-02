-- ============================================================
-- Retention: nightly compaction + purge (03:00 UTC)
-- PRD Section 10.4
-- ============================================================

-- Compact JSONB payloads older than 14 days (hot → warm tier)
SELECT cron.schedule(
  'compact-execution-payloads',
  '0 3 * * *',
  $$
    UPDATE workflow_executions
    SET trigger_payload = NULL, response_body = NULL
    WHERE started_at < now() - INTERVAL '14 days'
      AND trigger_payload IS NOT NULL;

    UPDATE execution_steps
    SET input = NULL, output = NULL
    WHERE started_at < now() - INTERVAL '14 days'
      AND input IS NOT NULL;
  $$
);

-- Purge rows older than 90 days (warm → cold tier)
-- CASCADE handles execution_steps automatically
-- ⚠️  DO NOT ACTIVATE until export to Google Sheets (or equivalent) is wired up.
--     Until then, disable this job: SELECT cron.unschedule('purge-old-executions');
SELECT cron.schedule(
  'purge-old-executions',
  '30 3 * * *',
  $$
    DELETE FROM workflow_executions
    WHERE started_at < now() - INTERVAL '90 days';
  $$
);

-- ============================================================
-- Auto-create next month's partitions (runs 1st of each month)
-- ============================================================

CREATE OR REPLACE FUNCTION create_next_month_partitions()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  next_month DATE := date_trunc('month', now() + INTERVAL '1 month');
  end_month  DATE := next_month + INTERVAL '1 month';
  suffix     TEXT := TO_CHAR(next_month, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS workflow_executions_%s
     PARTITION OF workflow_executions
     FOR VALUES FROM (%L) TO (%L)',
    suffix, next_month, end_month
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS execution_steps_%s
     PARTITION OF execution_steps
     FOR VALUES FROM (%L) TO (%L)',
    suffix, next_month, end_month
  );
END;
$$;

SELECT cron.schedule(
  'create-monthly-partitions',
  '0 0 1 * *',
  'SELECT create_next_month_partitions()'
);
