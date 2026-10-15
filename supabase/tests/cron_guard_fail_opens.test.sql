-- Behavioural tests for the second record of cron guard fail-opens (#2166),
-- cron_guard_fail_opens, which the tail worker writes from the guard's
-- FAILED OPEN log lines and the hourly check counts with the KV record.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHAT IT PROVES.
--   A. A fail-open written twice is one row: the tail worker's upsert, which
--      ignores a row already there, keeps the first copy.
--   B. A line over 1,000 characters is refused, which is why the tail worker
--      cuts each line to that length before writing it.
--   C. The browser roles reach neither the table nor the purge, and row level
--      security is on; the worker's role can read and write it.
--   D. Retention removes rows older than 7 days, keeps the rest, and is
--      scheduled in pg_cron with its own budget.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS cgfo_cases (name text PRIMARY KEY);
DELETE FROM cgfo_cases;
DELETE FROM public.cron_guard_fail_opens WHERE event_id LIKE 'cgfo-test-%';

-- ── A. One fail-open, one row ────────────────────────────────────────────────
DO $do$
BEGIN
  INSERT INTO public.cron_guard_fail_opens (event_id, occurred_at, cron, line)
  VALUES ('cgfo-test-a', '2026-10-14T21:34:02Z', '* * * * *', '[cron-once] FAILED OPEN event=cgfo-test-a first copy')
  ON CONFLICT (event_id) DO NOTHING;
  INSERT INTO public.cron_guard_fail_opens (event_id, occurred_at, cron, line)
  VALUES ('cgfo-test-a', '2026-10-14T21:34:09Z', '* * * * *', '[cron-once] FAILED OPEN event=cgfo-test-a second copy')
  ON CONFLICT (event_id) DO NOTHING;
  IF (SELECT count(*) FROM public.cron_guard_fail_opens WHERE event_id = 'cgfo-test-a') <> 1 THEN
    RAISE EXCEPTION 'one fail-open written twice made more than one row';
  END IF;
  IF (SELECT line FROM public.cron_guard_fail_opens WHERE event_id = 'cgfo-test-a') NOT LIKE '%first copy' THEN
    RAISE EXCEPTION 'a second copy replaced the first';
  END IF;
  INSERT INTO cgfo_cases VALUES ('a fail-open written twice is one row');
END
$do$;

-- ── B. A line past the limit is refused, so the tail worker's cap is the rule ─
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.cron_guard_fail_opens (event_id, occurred_at, line)
    VALUES ('cgfo-test-long', now(), repeat('x', 1001));
    RAISE EXCEPTION 'a 1,001 character line was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO cgfo_cases VALUES ('a line over 1,000 characters is refused');
END
$do$;

-- ── C. The browser roles reach nothing ───────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.cron_guard_fail_opens', 'SELECT')
       OR has_table_privilege(r, 'public.cron_guard_fail_opens', 'INSERT')
       OR has_table_privilege(r, 'public.cron_guard_fail_opens', 'UPDATE')
       OR has_table_privilege(r, 'public.cron_guard_fail_opens', 'DELETE') THEN
      RAISE EXCEPTION '% can reach cron_guard_fail_opens', r;
    END IF;
    IF has_function_privilege(r, 'public.purge_cron_guard_fail_opens()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can run the purge', r;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_guard_fail_opens'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on cron_guard_fail_opens';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.cron_guard_fail_opens', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.cron_guard_fail_opens', 'INSERT') THEN
    RAISE EXCEPTION 'the worker''s role cannot read and write the record';
  END IF;
  INSERT INTO cgfo_cases VALUES ('anon and authenticated can neither read nor write the record');
END
$do$;

-- ── D. Retention ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  removed int;
BEGIN
  DELETE FROM public.cron_guard_fail_opens WHERE event_id LIKE 'cgfo-test-%';
  INSERT INTO public.cron_guard_fail_opens (event_id, occurred_at, line) VALUES
    ('cgfo-test-old', now() - interval '7 days 1 minute', 'old'),
    ('cgfo-test-recent', now() - interval '6 days 23 hours', 'recent'),
    ('cgfo-test-today', now() - interval '1 hour', 'today');
  removed := public.purge_cron_guard_fail_opens();
  IF removed <> 1 THEN RAISE EXCEPTION 'purge removed % rows, expected 1', removed; END IF;
  IF EXISTS (SELECT 1 FROM public.cron_guard_fail_opens WHERE event_id = 'cgfo-test-old') THEN RAISE EXCEPTION 'a row past 7 days survived'; END IF;
  IF (SELECT count(*) FROM public.cron_guard_fail_opens WHERE event_id IN ('cgfo-test-recent', 'cgfo-test-today')) <> 2 THEN
    RAISE EXCEPTION 'the purge removed a row inside 7 days';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'purge-cron-guard-fail-opens'
      AND command LIKE '%purge_cron_guard_fail_opens()%'
      AND command LIKE '%statement_timeout = ''30s''%'
  ) THEN
    RAISE EXCEPTION 'the retention purge is not scheduled with its budget';
  END IF;
  INSERT INTO cgfo_cases VALUES ('retention removes only rows over 7 days old');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.cron_guard_fail_opens WHERE event_id LIKE 'cgfo-test-%';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM cgfo_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'cron_guard_fail_opens.test.sql: % cases passed', n;
END
$do$;
