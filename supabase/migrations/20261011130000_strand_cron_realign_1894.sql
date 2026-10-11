-- ============================================================
-- Bring the two stranded-run cleanup pg_cron jobs in line with production (#1894)
-- ============================================================
-- Found 2026-10-08 during #1884: production pg_cron had drifted from the migrations.
--
--   * Job `reduce-finalize-stranded` (every 30 min, now `27,57 * * * *`) runs
--     `reduce_finalize_stranded(1)` in production, but `20260625000001` scheduled
--     it with `(8)` and no later migration changed the command (20261008120000
--     altered only its schedule and said in words it was not the place to decide
--     the argument). So a database rebuilt from migrations ran an 8-day drain
--     every 30 minutes, not the 1-day shallow pass production runs.
--   * Job `reduce-finalize-stranded-deep` (`45 7 * * *`, `reduce_finalize_stranded(8)`)
--     runs in production but was scheduled by NO migration at all, so a rebuild
--     had no daily deep pass, and the guards that read the job set from the
--     migrations could not see it.
--
-- This migration sets both jobs to exactly what production runs today, so a
-- restore or the SQL suite reproduces the real schedule. The design is a frequent
-- shallow pass (1 day, catches the common recent strand cheaply now that it also
-- prunes its partitions, #1722) plus one daily deep pass (8 days, the backstop).
--
-- IN PLACE, so each job's jobid and run history survive (#770, L576). cron.alter_job
-- keeps the jobid; cron.schedule by name does too (it upserts on the name,
-- measured preserving the jobid on 2026-10-11), unlike the unschedule-and-reschedule
-- pair older migrations used, which mints a new id and discards the history.
--
-- Both calls are written in the shapes apps/web/src/lib/__tests__/_pg-cron.ts reads
-- (cron.alter_job by the job_id subselect with a $$-quoted command; cron.schedule
-- with its three literal arguments), so the deep pass is now visible to every guard
-- that builds the job set from the migrations.
--
-- Expand/contract: only pg_cron rows change. No schema, no function, no signature,
-- so the deployed worker is unaffected in either order (ADR 0007).
--
-- Guarded by supabase/tests/strand_cron_jobs.test.sql, which replays the
-- migrations and asserts both jobs' schedule and command, so a future migration
-- cannot silently revert the argument or drop the deep pass again.

-- A job this migration expects and cannot find is refused by name, rather than
-- left to cron.alter_job's own error about a null id (L11).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reduce-finalize-stranded') THEN
    RAISE EXCEPTION '#1894: pg_cron job reduce-finalize-stranded is missing, so its command cannot be altered';
  END IF;
END
$$;

-- Job `reduce-finalize-stranded`: the shallow 1-day pass production runs. Only the
-- command changes; the `27,57 * * * *` schedule 20261008120000 set is kept.
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'reduce-finalize-stranded'),
  command := $$SELECT public.reduce_finalize_stranded(1)$$
);

-- Job `reduce-finalize-stranded-deep`: the daily deep 8-day pass. cron.schedule by
-- name creates it on a database rebuilt from migrations and, in production where it
-- already exists with these values, updates it in place keeping its jobid.
SELECT cron.schedule(
  'reduce-finalize-stranded-deep',
  '45 7 * * *',
  $$SELECT public.reduce_finalize_stranded(8)$$
);
