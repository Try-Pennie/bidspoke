-- ============================================================
-- An explicit statement_timeout on every scheduled database job (#1149)
-- ============================================================
-- pg_cron runs as `postgres`, which carries no statement_timeout in rolconfig, so
-- every job inherited the cluster default of 120s. Nothing chose that number, and
-- an inherited ceiling becomes load-bearing silently as work grows: that is how
-- refresh_field_presence_daily was killed at 121.97s while every health signal read
-- normal (#1147, L188). #1147 fixed the two rollups by stating the budget in the
-- cron command. This covers the rest.
--
-- TWO SHAPES OF JOB, because the budget cannot be stated the same way for both
-- (all measured against this Postgres 17 on 2026-10-11):
--
--   * SELECT-of-function jobs take the budget in the cron command, as the rollups
--     do: `SET statement_timeout = '...'; SET lock_timeout = '...'; SELECT fn()`.
--     The SET binds because the function runs as one statement in one transaction.
--
--   * CALL-of-procedure jobs (the partition purge and friends) CANNOT. A procedure
--     here COMMITs internally, and:
--       - prefixing `SET ...; CALL proc()` makes pg_cron send a multi-statement
--         simple query, which runs in one implicit transaction, and the procedure's
--         first COMMIT then fails with "invalid transaction termination";
--       - `ALTER PROCEDURE ... SET statement_timeout` wraps the call the same way
--         and fails identically;
--       - a `SET` as the procedure's first line does not bind: the statement_timeout
--         timer is armed when the CALL begins (with the inherited value) and is
--         cumulative across the internal COMMITs, not re-read.
--     So the only lever for them is the role default, made explicit below. 120s is
--     adequate for all four: the purge's own lock_timeout is 2s and its retry window
--     ~42s per partition, it is re-runnable (a kill just defers a partition to the
--     next run), and the measured p99s are 2.8s/8.9s/12.3s/19.9s.
--
-- Expand/contract: only pg_cron commands and the postgres role's own GUC default
-- change. No schema, no function signature, so the deployed worker is unaffected in
-- either order (ADR 0007). Service_role (30s), authenticator (8s) and every
-- per-command SET keep their own values; this only governs postgres sessions that
-- set nothing, which is the committing-procedure jobs and bare admin/migration runs
-- (already 120s, so no behaviour changes).
--
-- Guarded by apps/web/src/lib/__tests__/scheduled-job-timeout-budget.test.ts and
-- supabase/tests/scheduled_job_timeouts.test.sql.

-- Every job this migration alters must exist, or cron.alter_job errors on a null
-- id with nothing naming which job was missing (L11).
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT array_agg(n ORDER BY n) INTO v_missing
  FROM unnest(ARRAY[
    'create-monthly-analytics-partitions',
    'finalize-unrecoverable-stranded',
    'reduce-finalize-stranded',
    'reduce-finalize-stranded-deep',
    'prune-orphan-auth-users',
    'drop-exported-sighting-partitions'
  ]) n
  WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = n);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '#1149: pg_cron job(s) % are missing, so their budgets cannot be set', v_missing;
  END IF;
END
$$;

-- ------------------------------------------------------------------
-- 1. SELECT-of-function jobs: budget in the cron command
-- ------------------------------------------------------------------
-- Each budget is a generous multiple of the job's measured max (30 days to
-- 2026-10-11), kept well under an interval, with lock_timeout at 10s, a small
-- fraction of every budget (one sixth of 60s, one twelfth of 120s), so a lock
-- wait cannot consume the statement budget the way the one in #1147 did. All six
-- are idempotent, so aborting a lock wait at 10s and retrying next run is safe.

-- 60s; measured max 6.0s. Monthly.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'create-monthly-analytics-partitions'),
  command := $$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT create_monthly_analytics_partitions()$$
);

-- 60s; measured max 8.4s. Daily.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'finalize-unrecoverable-stranded'),
  command := $$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.finalize_unrecoverable_stranded(26)$$
);

-- 120s; measured max 63.5s (pre-#1722 lock contention, now pruned to ~15s). Every 30 min.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'reduce-finalize-stranded'),
  command := $$SET statement_timeout = '120s'; SET lock_timeout = '10s'; SELECT public.reduce_finalize_stranded(1)$$
);

-- 60s; measured max 7.5s. Daily.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'reduce-finalize-stranded-deep'),
  command := $$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.reduce_finalize_stranded(8)$$
);

-- 60s; measured max 0.1s. Weekly.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'prune-orphan-auth-users'),
  command := $$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.prune_orphan_auth_users()$$
);

-- 60s; measured max 2.3s. Daily.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'drop-exported-sighting-partitions'),
  command := $$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.drop_exported_sighting_partitions()$$
);

-- ------------------------------------------------------------------
-- 2. CALL-of-procedure jobs: the role default, made explicit
-- ------------------------------------------------------------------
-- create-daily-partitions, purge-old-execution-partitions,
-- reap-empty-execution-partitions and purge-exported-sightings all CALL committing
-- procedures and so cannot carry a per-command budget (see the header). This pins
-- the value they inherit, so it is chosen and recorded rather than whatever the
-- cluster happens to default to. Setting it to 120s matches the current effective
-- value, so nothing changes today; it only stops the ceiling moving underneath
-- these jobs unnoticed. A session SET in a migration still overrides it for a
-- deliberately long operation.
ALTER ROLE postgres SET statement_timeout = '120s';
