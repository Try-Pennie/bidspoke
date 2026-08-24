-- Extend execution retention from 14 to 21 days while nobody is available to react.
--
-- WHY. Migration 20260823000002 raised 7 to 14 as insurance against the archive
-- backlog not draining, because the nightly purge deletes a day whether or not the
-- archive backed it up: deletion is still not gated on the archive (#873). That
-- insurance was sized against being back on Aug 31. Measured 2026-08-24, the
-- backlog is larger than that migration assumed: 08-18 has 1 of 24 hours, 08-22 has
-- 3, 08-23 has 22, and 08-17 has 23, so roughly 119 hours are still unarchived.
--
-- At 14 days the oldest of those (2026-08-18) is purged on Sep 2, which is two days
-- after the earliest return. Two days is not margin when the failure mode is
-- SILENT: a stalled backlog walk raises no alert, because the alert that would say
-- so is the deletion gate that #873 has not built yet. At 21 days that day survives
-- to Sep 9, which leaves time to notice and act after returning rather than
-- discovering a day died the night before.
--
-- WHAT IT COSTS. Measured on 2026-08-24: 2.23 GB per populated day, almost all of it
-- execution_steps. The 14 day setting is not yet materialised (only 9 day partitions
-- exist, after the 2026-08-14 reclaim), so the database grows about 11 GB on its own
-- reaching 14 days. This adds roughly 16 GB beyond that, putting it near 50 GB.
-- That is the deliberate trade: disk is recoverable, a purged unarchived day is not.
--
-- PUT IT BACK once `execution_archive_hours` shows 24 hours for every day the
-- database still holds. Going straight back to 7 will then drop many days at once,
-- so check what the truncate will take before running it.
--
-- Both jobs move together, because the nightly TRUNCATE and the weekly reaper are
-- two halves of one policy: a reaper left on 14 would detach and drop the very
-- partitions the truncate has been told to keep.
-- `apps/web/src/lib/execution-retention.ts` moves with them, and
-- `apps/web/src/lib/__tests__/cron-threshold-within-retention.test.ts` derives the
-- window from the last migration that schedules a purge, so the two cannot drift.
--
-- Same names, so this REPLACES the existing schedules rather than adding a second
-- pair. Unschedule first, because cron.schedule on an existing name would otherwise
-- leave the old entry behind under a new id.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL truncate_expired_execution_partitions(21)'
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap-empty-execution-partitions'; END $$;

SELECT cron.schedule(
  'reap-empty-execution-partitions',
  '0 4 * * 0',
  'CALL drop_expired_execution_partitions_safe(21)'
);
