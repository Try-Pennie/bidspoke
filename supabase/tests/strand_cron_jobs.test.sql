-- The two stranded-run cleanup pg_cron jobs match production (#1894).
--
-- WHY THIS EXISTS: production pg_cron had drifted from the migrations (found
-- 2026-10-08 during #1884). `reduce-finalize-stranded` ran reduce_finalize_stranded(1)
-- in production while the migrations scheduled it with (8), and
-- `reduce-finalize-stranded-deep` ran in production but was scheduled by no
-- migration at all. 20261011130000 codifies both; this asserts that a database
-- rebuilt from the migrations reproduces exactly what production runs, so a future
-- migration cannot silently revert the argument or drop the deep pass.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Its cron.job is the
-- migration-derived job set.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS strand_cron_cases (name text PRIMARY KEY);
DELETE FROM strand_cron_cases;

-- ── 1. The shallow pass runs a 1-day lookback on its 27,57 schedule ──────────
DO $do$
DECLARE j cron.job%ROWTYPE;
BEGIN
  SELECT * INTO j FROM cron.job WHERE jobname = 'reduce-finalize-stranded';
  IF NOT FOUND THEN RAISE EXCEPTION 'reduce-finalize-stranded is not scheduled'; END IF;
  IF j.schedule IS DISTINCT FROM '27,57 * * * *' THEN RAISE EXCEPTION 'reduce-finalize-stranded schedule = %', j.schedule; END IF;
  -- The command carries a SET statement_timeout prefix (#1149); the lookback is what matters here.
  IF j.command NOT LIKE '%SELECT public.reduce_finalize_stranded(1)%' THEN RAISE EXCEPTION 'reduce-finalize-stranded command = %', j.command; END IF;
  IF j.active IS NOT TRUE THEN RAISE EXCEPTION 'reduce-finalize-stranded is not active'; END IF;
  INSERT INTO strand_cron_cases(name) VALUES ('shallow pass runs a 1-day lookback');
END
$do$;

-- ── 2. The deep pass exists and runs an 8-day lookback daily at 07:45 UTC ─────
DO $do$
DECLARE j cron.job%ROWTYPE;
BEGIN
  SELECT * INTO j FROM cron.job WHERE jobname = 'reduce-finalize-stranded-deep';
  IF NOT FOUND THEN RAISE EXCEPTION 'reduce-finalize-stranded-deep is not scheduled (the deep pass is missing)'; END IF;
  IF j.schedule IS DISTINCT FROM '45 7 * * *' THEN RAISE EXCEPTION 'reduce-finalize-stranded-deep schedule = %', j.schedule; END IF;
  IF j.command NOT LIKE '%SELECT public.reduce_finalize_stranded(8)%' THEN RAISE EXCEPTION 'reduce-finalize-stranded-deep command = %', j.command; END IF;
  IF j.active IS NOT TRUE THEN RAISE EXCEPTION 'reduce-finalize-stranded-deep is not active'; END IF;
  INSERT INTO strand_cron_cases(name) VALUES ('deep pass runs an 8-day lookback daily');
END
$do$;

-- ── 3. There is exactly one shallow and one deep strand drain, no stray copy ──
DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM cron.job WHERE jobname LIKE 'reduce-finalize-stranded%';
  IF n <> 2 THEN RAISE EXCEPTION 'expected exactly 2 reduce-finalize-stranded* jobs, found %', n; END IF;
  INSERT INTO strand_cron_cases(name) VALUES ('exactly two strand drain jobs');
END
$do$;

DO $do$
DECLARE n int := (SELECT count(*) FROM strand_cron_cases);
BEGIN
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'strand_cron_jobs.test.sql: % cases passed', n;
END
$do$;
