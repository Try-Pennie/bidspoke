-- Stop the rollup refreshes re-reading days that have not changed, and stop the
-- heavy scheduled readers starting in the same minute (#1884).
--
-- WHAT HAPPENED. On 2026-10-08 at 12:20 UTC the database stopped completing work
-- for about 30 seconds with its disk apparently out of burst allowance. Our own
-- scheduled reads dominate its disk IO. Measured from pg_stat_statements between
-- 2026-09-24 20:29 UTC and 2026-10-08:
--
--   refresh_workflow_stats_daily(2), every 5 minutes   296 MB read per run   1,178 GB
--   refresh_field_presence_daily(2), every 15 minutes  348 MB read per run     465 GB
--   reduce_finalize_stranded, every 30 minutes         103 MB read per run      69 GB
--
-- Both rollups recount three whole days of workflow_executions on every pass
-- (about 150 MB of heap per finished day), though only today changes from one
-- pass to the next. And jobs 24, 45 and 47 all started at :00 together with the
-- worker's hourly batch, while 45 and 47 also started at 08:15 with the
-- worker's timeout audit.
--
-- THE CHANGE. Each rollup now has three passes instead of two:
--
--   today        frequent, refresh(0): deletes and rewrites today's rows only
--   recent       hourly,   refresh(2): today and the two days before, which is
--                exactly what the frequent pass used to cover, so a late
--                completion or a stranded execution finalised later still lands
--                in its own day, now within the hour instead of within 5 minutes
--   full         nightly,  refresh(7): unchanged
--
-- No function changes: refresh(0) already means "today only", because both
-- functions delete `day >= CURRENT_DATE - p_lookback_days` and scan
-- [CURRENT_DATE - p_lookback_days, CURRENT_DATE + 1). Nothing about what a day
-- contains changes, only how soon a PAST day's late changes are folded in.
--
-- WHO READS A PAST DAY, and why an hour is enough:
--   workflow_stats_daily   the dashboard and workflows list (workflow_stats_rollup),
--                          and the 13:00 UTC volume anomaly check, which reads
--                          yesterday hours after the last recent pass.
--   field_presence_daily   the hourly drought detector, whose baseline is prior
--                          COMPLETE days and whose today side is read live
--                          (field_presence_window, #1101), and the field
--                          coverage page.
-- Across midnight yesterday stays nearly whole: its rows were last written by
-- the final frequent pass of the day (23:56 for stats, 23:49 for field
-- presence), and the recent pass at 00:08 and 00:42 adds the last minutes.
--
-- READS, from partition sizes on 2026-10-08 (a finished day is about 150 MB of
-- workflow_executions heap; today averages half that over the day):
--   stats   288 x 3 days a day      becomes 288 x today + 24 x 3 days, about 70% less
--   field    96 x 3 days a day      becomes  96 x today + 24 x 3 days, about 50% less
-- and today's partition is the one being written, so it is the likeliest to be
-- in memory already: the disk reads fall by more than the pages touched do.
--
-- THE SCHEDULE. The worker's crons fire on multiples of five minutes plus :23
-- and :37, so each heavy database reader gets minutes of its own:
--
--   minute  job
--   :00     worker hourly batch (archive backlog, parity, drift, drought...)
--   1 mod 5 refresh-workflow-stats-daily        today, every 5 minutes
--   :04 :19 :34 :49  refresh-field-presence-daily  today, every 15 minutes
--   :08     refresh-workflow-stats-daily-recent  hourly
--   :13     purge-exported-sightings             (unchanged)
--   :23     worker execution archive             (unchanged)
--   :27 :57 reduce-finalize-stranded             (was :00 and :30)
--   :37     worker sightings export, every 2 hours (unchanged)
--   :42     refresh-field-presence-daily-recent  hourly
--   03:47 and 03:52  the nightly full passes      (unchanged)
--   08:17   worker timeout audit                 (was 08:15, wrangler.toml)
--
-- apps/web/src/lib/__tests__/rollup-refresh-collision-guard.test.ts asserts no
-- rollup pass starts in a minute any other pg_cron job or worker cron does.
--
-- WHY ALTER, NOT UNSCHEDULE. cron.alter_job keeps each job's jobid, so its run
-- history in cron.job_run_details and the pg_cron watch's record of it carry on.
-- An unschedule and reschedule mints a new id and starts the watch's grace
-- period again (#770). Only the schedule of reduce-finalize-stranded is altered,
-- never its command, because the live command is not the one the migrations
-- wrote (it runs reduce_finalize_stranded(1); 20260625000001 scheduled it with 8)
-- and this migration is not the place to decide which is right.
--
-- The statement_timeout of each pass stays in its cron command, where it binds
-- (#1147), and every frequent pass's budget plus a minute still fits inside its
-- own interval.
--
-- Expand/contract: only pg_cron rows change. No schema, no function, no signature,
-- so the deployed worker is unaffected in either order (ADR 0007).

-- A job this migration expects and cannot find is refused by name, rather than
-- left to cron.alter_job's own error about a null id (L11).
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT array_agg(n ORDER BY n) INTO v_missing
  FROM unnest(ARRAY['refresh-workflow-stats-daily', 'refresh-field-presence-daily', 'reduce-finalize-stranded']) n
  WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = n);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '#1884: pg_cron job(s) % are missing, so their schedules cannot be altered', v_missing;
  END IF;
END
$$;

-- ------------------------------------------------------------------
-- 1. workflow_stats_daily
-- ------------------------------------------------------------------
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily'),
  schedule := '1-59/5 * * * *',
  command := $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_workflow_stats_daily(0)$$
);

SELECT cron.schedule(
  'refresh-workflow-stats-daily-recent',
  '8 * * * *',
  $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_workflow_stats_daily(2)$$
);

-- ------------------------------------------------------------------
-- 2. field_presence_daily
-- ------------------------------------------------------------------
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'refresh-field-presence-daily'),
  schedule := '4-59/15 * * * *',
  command := $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_field_presence_daily(0)$$
);

SELECT cron.schedule(
  'refresh-field-presence-daily-recent',
  '42 * * * *',
  $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_field_presence_daily(2)$$
);

-- ------------------------------------------------------------------
-- 3. The stranded execution drain leaves the top of the hour
-- ------------------------------------------------------------------
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'reduce-finalize-stranded'),
  schedule := '27,57 * * * *'
);
