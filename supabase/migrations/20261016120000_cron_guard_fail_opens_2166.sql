-- The second record of every cron guard fail-open (#2166).
--
-- The worker's cron guard (apps/worker/src/lib/cron-once.ts) runs a tick
-- unguarded when its claim object does not answer, logs `[cron-once] FAILED
-- OPEN event=<id> ...`, and records the event in KV for the hourly check
-- (cron-guard-watch.ts). That KV write fails in the same platform blip that
-- makes the guard fail open: on 2026-10-14, 9 FAILED OPEN lines were logged and
-- 3 counted, and a cluster of six that should have paged did not.
--
-- HOW ROWS ARRIVE. The tail worker (apps/worker-tail/src/fail-opens.ts) is
-- handed the worker's log lines after each invocation ends, and copies each
-- FAILED OPEN line here by its event id: a record written by a different worker,
-- later, into a different store, so it does not share the failing write (L561).
-- The hourly check counts the union of KV and this table by event_id, and says
-- in the page when the two disagree or one cannot be read.
--
-- THE KEY is the event id the guard minted, so a batch the tail worker writes
-- twice (a retry, a held row written again) is one row: it upserts ignoring a
-- row already there.
--
-- RETENTION. The check reads the last 24 hours. Rows are kept 7 days so a
-- cluster can be looked at after the page, then deleted daily by pg_cron. A
-- whole day of the minute tick failing open is 1,440 rows, so the table stays
-- small whatever happens.
--
-- SCOPE. Platform rows, no organization: the guard runs the worker's own
-- crons. Service role only; the browser roles are revoked outright (L124).
--
-- Expand/contract (ADR 0007): additive. A new table, one function and a cron
-- job. The deployed worker does not read the table until the code in the same
-- pull request ships, and the tail worker writes nothing to it until then.
--
-- Guarded by supabase/tests/cron_guard_fail_opens.test.sql.

CREATE TABLE IF NOT EXISTS public.cron_guard_fail_opens (
  event_id     text PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  cron         text,
  line         text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cron_guard_fail_opens_event_id_check CHECK (length(event_id) BETWEEN 1 AND 100),
  CONSTRAINT cron_guard_fail_opens_line_check CHECK (length(line) <= 1000)
);

COMMENT ON TABLE public.cron_guard_fail_opens IS
  'One row per cron guard fail-open, copied from its FAILED OPEN log line by the tail worker (#2166). The hourly cron guard check counts these with the KV record. Service role only; rows older than 7 days are purged daily.';
COMMENT ON COLUMN public.cron_guard_fail_opens.event_id IS
  'The id the guard minted and logged as event=<id>; the same id names the KV record, so the check counts one fail-open once.';
COMMENT ON COLUMN public.cron_guard_fail_opens.occurred_at IS
  'When the FAILED OPEN line was logged. The check''s 24 hour window keys on this.';
COMMENT ON COLUMN public.cron_guard_fail_opens.line IS
  'The FAILED OPEN line itself, up to 1,000 characters: which tick, and why the claim did not answer.';

CREATE INDEX IF NOT EXISTS cron_guard_fail_opens_occurred_idx
  ON public.cron_guard_fail_opens (occurred_at DESC);

ALTER TABLE public.cron_guard_fail_opens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_guard_fail_opens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cron_guard_fail_opens TO service_role;

CREATE OR REPLACE FUNCTION public.purge_cron_guard_fail_opens()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM cron_guard_fail_opens
  WHERE occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_cron_guard_fail_opens() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_cron_guard_fail_opens() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-cron-guard-fail-opens') THEN
    PERFORM cron.schedule(
      'purge-cron-guard-fail-opens',
      '47 6 * * *',
      $cmd$SET statement_timeout = '30s'; SET lock_timeout = '10s'; SELECT public.purge_cron_guard_fail_opens()$cmd$
    );
  END IF;
END
$$;
