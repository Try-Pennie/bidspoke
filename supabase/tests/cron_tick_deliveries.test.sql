-- Behavioural tests for the record of every cron delivery (#2284),
-- cron_tick_deliveries, which the tail worker writes from the guard's delivery
-- log lines and the hourly cron guard check reads for a tick that ran twice.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHAT IT PROVES.
--   A. A delivery written twice is one row: the tail worker's upsert, which
--      ignores a row already there, keeps the first copy.
--   B. Only the five outcomes the guard and the tail worker write are accepted,
--      and an id over 200 characters is refused, which is why the tail worker
--      refuses such an id before batching it.
--   C. The browser roles reach neither the table nor the purge, and row level
--      security is on; the worker's role can read and write it.
--   D. Retention removes rows older than 7 days, keeps the rest, and is
--      scheduled in pg_cron with its own budget.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS ctd_cases (name text PRIMARY KEY);
DELETE FROM ctd_cases;
DELETE FROM public.cron_tick_deliveries WHERE delivery_id LIKE 'ctd-test-%';

-- ── A. One delivery, one row ─────────────────────────────────────────────────
DO $do$
BEGIN
  INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome, invocation_outcome)
  VALUES ('ctd-test-a', '2026-10-17T15:15:36Z', '*/5 * * * *', '2026-10-17T15:15:32.618Z', 'failed_open', 'ok')
  ON CONFLICT (delivery_id) DO NOTHING;
  INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome, invocation_outcome)
  VALUES ('ctd-test-a', '2026-10-17T15:15:40Z', '*/5 * * * *', '2026-10-17T15:15:32.618Z', 'ran', 'canceled')
  ON CONFLICT (delivery_id) DO NOTHING;
  IF (SELECT count(*) FROM public.cron_tick_deliveries WHERE delivery_id = 'ctd-test-a') <> 1 THEN
    RAISE EXCEPTION 'one delivery written twice made more than one row';
  END IF;
  IF (SELECT outcome FROM public.cron_tick_deliveries WHERE delivery_id = 'ctd-test-a') <> 'failed_open' THEN
    RAISE EXCEPTION 'a second copy replaced the first';
  END IF;
  INSERT INTO ctd_cases VALUES ('a delivery written twice is one row');
END
$do$;

-- ── B. Only the known outcomes, and ids the tail worker will send ────────────
DO $do$
DECLARE
  o text;
BEGIN
  FOREACH o IN ARRAY ARRAY['ran', 'took_over', 'failed_open', 'skipped', 'no_decision'] LOOP
    INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome)
    VALUES ('ctd-test-outcome-' || o, now(), '* * * * *', now(), o);
  END LOOP;
  BEGIN
    INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome)
    VALUES ('ctd-test-bad', now(), '* * * * *', now(), 'exploded');
    RAISE EXCEPTION 'an unknown outcome was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome)
    VALUES ('ctd-test-' || repeat('x', 192), now(), '* * * * *', now(), 'ran');
    RAISE EXCEPTION 'a 201 character id was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO ctd_cases VALUES ('only the five outcomes, and ids up to 200 characters, are accepted');
END
$do$;

-- ── C. The browser roles reach nothing ───────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.cron_tick_deliveries', 'SELECT')
       OR has_table_privilege(r, 'public.cron_tick_deliveries', 'INSERT')
       OR has_table_privilege(r, 'public.cron_tick_deliveries', 'UPDATE')
       OR has_table_privilege(r, 'public.cron_tick_deliveries', 'DELETE') THEN
      RAISE EXCEPTION '% can reach cron_tick_deliveries', r;
    END IF;
    IF has_function_privilege(r, 'public.purge_cron_tick_deliveries()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can run the purge', r;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_tick_deliveries'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on cron_tick_deliveries';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.cron_tick_deliveries', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.cron_tick_deliveries', 'INSERT') THEN
    RAISE EXCEPTION 'the worker''s role cannot read and write the record';
  END IF;
  INSERT INTO ctd_cases VALUES ('anon and authenticated can neither read nor write the record');
END
$do$;

-- ── D. Retention ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  removed int;
BEGIN
  DELETE FROM public.cron_tick_deliveries WHERE delivery_id LIKE 'ctd-test-%';
  INSERT INTO public.cron_tick_deliveries (delivery_id, occurred_at, cron, scheduled_at, outcome) VALUES
    ('ctd-test-old', now() - interval '7 days 1 minute', '* * * * *', now() - interval '7 days 1 minute', 'ran'),
    ('ctd-test-recent', now() - interval '6 days 23 hours', '* * * * *', now() - interval '6 days 23 hours', 'ran'),
    ('ctd-test-today', now() - interval '1 hour', '* * * * *', now() - interval '1 hour', 'skipped');
  removed := public.purge_cron_tick_deliveries();
  IF removed <> 1 THEN RAISE EXCEPTION 'purge removed % rows, expected 1', removed; END IF;
  IF EXISTS (SELECT 1 FROM public.cron_tick_deliveries WHERE delivery_id = 'ctd-test-old') THEN RAISE EXCEPTION 'a row past 7 days survived'; END IF;
  IF (SELECT count(*) FROM public.cron_tick_deliveries WHERE delivery_id IN ('ctd-test-recent', 'ctd-test-today')) <> 2 THEN
    RAISE EXCEPTION 'the purge removed a row inside 7 days';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'purge-cron-tick-deliveries'
      AND command LIKE '%purge_cron_tick_deliveries()%'
      AND command LIKE '%statement_timeout = ''30s''%'
  ) THEN
    RAISE EXCEPTION 'the retention purge is not scheduled with its budget';
  END IF;
  INSERT INTO ctd_cases VALUES ('retention removes only rows over 7 days old');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.cron_tick_deliveries WHERE delivery_id LIKE 'ctd-test-%';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM ctd_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'cron_tick_deliveries.test.sql: % cases passed', n;
END
$do$;
