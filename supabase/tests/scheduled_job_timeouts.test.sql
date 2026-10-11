-- Every scheduled pg_cron job has a chosen statement_timeout (#1149).
--
-- WHY THIS EXISTS: pg_cron runs as postgres with no statement_timeout, so jobs
-- inherited the 120s cluster default; nothing chose it, and it killed a rollup at
-- 121.97s (#1147). 20261011140000 states a budget on every SELECT-of-function job
-- in its command, and makes the postgres role default explicit for the
-- CALL-of-procedure jobs, which cannot take a per-command budget (a SET before a
-- committing CALL runs in one implicit transaction whose COMMIT then fails).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS job_timeout_cases (name text PRIMARY KEY);
DELETE FROM job_timeout_cases;

-- ── 1. Every function job states its own statement_timeout ───────────────────
DO $do$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(jobname ORDER BY jobname) INTO missing
  FROM cron.job
  WHERE command NOT ILIKE '%CALL %'           -- SELECT-of-function jobs only
    AND command NOT ILIKE '%statement_timeout%';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'function job(s) with no statement_timeout in their command: %', missing;
  END IF;
  INSERT INTO job_timeout_cases(name) VALUES ('every function job states a statement_timeout');
END
$do$;

-- ── 2. The two strand drains and the maintenance jobs carry the expected budget ─
DO $do$
DECLARE c text;
BEGIN
  -- Assert the literal budget, not just presence: a wrong or absurd value must fail.
  SELECT command INTO c FROM cron.job WHERE jobname = 'reduce-finalize-stranded';
  IF c NOT LIKE '%statement_timeout = ''120s''%' OR c NOT LIKE '%SELECT public.reduce_finalize_stranded(1)%' THEN
    RAISE EXCEPTION 'reduce-finalize-stranded command = %', c;
  END IF;
  SELECT command INTO c FROM cron.job WHERE jobname = 'finalize-unrecoverable-stranded';
  IF c NOT LIKE '%statement_timeout = ''60s''%' THEN RAISE EXCEPTION 'finalize-unrecoverable-stranded budget = %', c; END IF;
  INSERT INTO job_timeout_cases(name) VALUES ('strand and maintenance jobs carry a budget');
END
$do$;

-- ── 3. The postgres role default is stated explicitly (for the CALL procedures) ─
DO $do$
DECLARE cfg text[];
BEGIN
  SELECT rolconfig INTO cfg FROM pg_roles WHERE rolname = 'postgres';
  IF NOT EXISTS (SELECT 1 FROM unnest(cfg) x WHERE x = 'statement_timeout=120s') THEN
    RAISE EXCEPTION 'the postgres role default statement_timeout is not the expected 120s; rolconfig = %', cfg;
  END IF;
  INSERT INTO job_timeout_cases(name) VALUES ('postgres role default statement_timeout is explicit');
END
$do$;

DO $do$
DECLARE n int := (SELECT count(*) FROM job_timeout_cases);
BEGIN
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'scheduled_job_timeouts.test.sql: % cases passed', n;
END
$do$;
