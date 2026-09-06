-- Put execution retention back to its designed 7 days (#1038).
--
-- WHY IT WAS LONGER. Migration 20260823000002 raised 7 to 14 and 20260824000002
-- raised 14 to 21, both as insurance: the archive backlog was draining slowly
-- and the nightly purge then deleted a day whether or not the archive held it,
-- so a stalled backlog walk would have destroyed unarchived days with no alert.
-- The number was never about how long anyone needs execution history; it was
-- the only safety margin there was while deletion was ungated.
--
-- WHY IT CAN GO BACK NOW. Two things changed, and both were read from
-- production on 2026-09-06 before writing this:
--   1. Deletion is gated (#873, migration 20260903210000). Both jobs call the
--      verified procedures, which truncate or drop a day only when the archive
--      gate has measured it and found execution counts, step counts and the
--      payload probe agreeing with Postgres. A day the archive cannot vouch for
--      is refused, so the window is no longer insurance against deletion.
--   2. Every retained day is archived: execution_archive_hours shows 24 of 24
--      hours for every UTC day from 2026-08-17 through 2026-09-05.
--
-- WHAT THIS RELEASES. At 7 days verified_purgeable_days authorises 14 execution
-- days (2026-08-16 to 08-29) and 13 step days (08-17 to 08-29) and refuses none.
-- Those partitions held 29 GB of execution_steps and 5.3 GB of
-- workflow_executions, about 34 GB of a 56 GB database. The step partition for
-- 2026-08-16 stays: the gate requires the previous day verified and 08-15 was
-- purged before the archive existed, which is a separate issue.
--
-- FIRST REAL DELETION. The gated jobs ran on 2026-09-05 and 09-06 with an empty
-- day list, because at 21 days nothing was yet eligible. The first run at 7 is
-- therefore the first time the gate deletes anything, and it is called by hand
-- once, watched, before the schedule takes over.
--
-- Both jobs move together, because the nightly TRUNCATE and the weekly reaper
-- are two halves of one policy: a reaper left on 21 would keep shells the
-- truncate had emptied for two extra weeks, and a truncate left on 21 while the
-- reaper dropped at 7 would be refused by the reaper's still-holds-rows check.
-- `apps/worker/src/archive/candidate-days.ts` (RETENTION_DAYS) and
-- `apps/web/src/lib/execution-retention.ts` (EXECUTION_RETENTION_DAYS) move with
-- them; `cron-threshold-within-retention.test.ts`,
-- `archive-retention-matches-purge.test.ts` and `verified-deletion-gate.test.ts`
-- derive the window from the last migration that schedules a purge and fail
-- when any of the three disagree.
--
-- Same names, so this REPLACES the existing schedules rather than adding a
-- second pair. Unschedule first, because cron.schedule on an existing name
-- would otherwise leave the old entry behind under a new id.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL truncate_verified_execution_partitions(7)'
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap-empty-execution-partitions'; END $$;

SELECT cron.schedule(
  'reap-empty-execution-partitions',
  '0 4 * * 0',
  'CALL drop_verified_execution_partitions(7)'
);
