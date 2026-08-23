-- Temporarily lengthen execution retention from 7 to 14 days.
--
-- WHY, and WHEN TO PUT IT BACK. On 2026-08-23 six days (2026-08-17 to 08-22) were
-- between 0 and 21 of their 24 hours archived, and the nightly purge deletes a day
-- eight days after it starts, whether or not the archive backed it up: deletion is
-- not gated on the archive yet (#873). So those days were on a countdown of one per
-- night, Aug 25 to Aug 30, with nobody available to intervene until Aug 31.
--
-- The hourly backlog walk (#1015, #1021) should clear that backlog around Aug 26,
-- comfortably inside every deadline. This is the insurance in case it does not: at
-- 14 days the same six days survive to Sep 1 and later, so a stalled catch-up costs
-- nothing recoverable.
--
-- PUT IT BACK TO 7 once `execution_archive_hours` shows 24 hours for every day the
-- database still holds. The cost of leaving it is roughly one extra day of hot
-- execution rows per day of retention, measured at about 82,500 executions and
-- 868,000 steps for 2026-08-16, so about 7 days more data than the design intends.
--
-- Both jobs move together, because the nightly TRUNCATE and the weekly reaper are
-- two halves of one policy and a reaper still on 7 would detach and drop the very
-- partitions the truncate has been told to keep. `apps/web/src/lib/execution-retention.ts`
-- moves with them, and a guard test now enforces that rather than a comment asking
-- for it (apps/web/src/lib/__tests__/retention-matches-purge-cron.test.ts).
--
-- Same names, so this REPLACES the existing schedules rather than adding a second
-- pair. Unschedule first, because cron.schedule on an existing name would otherwise
-- leave the old entry behind under a new id.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL truncate_expired_execution_partitions(14)'
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap-empty-execution-partitions'; END $$;

SELECT cron.schedule(
  'reap-empty-execution-partitions',
  '0 4 * * 0',
  'CALL drop_expired_execution_partitions_safe(14)'
);
