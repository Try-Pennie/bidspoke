-- ============================================================
-- app_config: key-value store for infrastructure flags
-- ============================================================
-- Used by pg_cron jobs and admin scripts to check runtime config.
-- Access is restricted to the service role (no RLS needed — no tenant data).

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  note  TEXT
);

-- Logpush must be confirmed active before cold-tier rows are purged.
-- Set to 'true' only after verifying Logpush is writing to R2/Snowflake:
--   UPDATE app_config SET value = 'true' WHERE key = 'logpush_active';
INSERT INTO app_config (key, value, note)
VALUES (
  'logpush_active',
  'false',
  'Set to ''true'' once Cloudflare Logpush is confirmed writing to R2/Snowflake. ' ||
  'The cold-tier purge (purge-old-executions) will not delete rows until this is true.'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Update the 90-day purge job to check logpush_active first
-- ============================================================

SELECT cron.unschedule('purge-old-executions');

SELECT cron.schedule(
  'purge-old-executions',
  '30 3 * * *',
  $$
    -- Only purge when Logpush archival is confirmed (PRD Section 3.5)
    DELETE FROM workflow_executions
    WHERE started_at < now() - INTERVAL '90 days'
      AND EXISTS (
        SELECT 1 FROM app_config
        WHERE key = 'logpush_active' AND value = 'true'
      );
  $$
);
