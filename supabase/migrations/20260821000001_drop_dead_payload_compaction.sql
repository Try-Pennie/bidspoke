-- ============================================================
-- Drop the dead payload-compaction cron (#826)
-- ============================================================
-- `compact-execution-payloads` (03:00 UTC, from 20260402000005) nulls
-- trigger_payload / response_body / step input / output on rows older than
-- 14 DAYS. `purge-old-execution-partitions` runs half an hour later and
-- truncates partitions at 7 DAYS.
--
-- No row can ever reach 14 days, so the job has matched ZERO rows on every run
-- since retention halved. Measured 2026-08-21: the oldest live execution was
-- 2026-08-14 (7 days), and the count of rows older than 14 days was 0.
--
-- It is dropped rather than retuned, deliberately. Retuning it to fire (say at
-- 3 days) would scrub payloads on ~449,000 rows that currently carry them, and
-- there is NO copy of those payloads anywhere: the nightly Snowflake export
-- covers lead_sightings (extracted summary fields) and achieve_evaluations, and
-- carries neither workflow_executions.trigger_payload / response_body nor
-- execution_steps.input / output. Shortening the window would therefore destroy
-- data with no backup, which is the opposite of what the retention work is for.
-- The execution archive (#866, #871) is what makes the payload durable; once it
-- is proven, shortening the local window becomes a real option. Dan's call,
-- 2026-08-21.
--
-- The load-bearing correction is to a COMMENT, not to behaviour.
-- 20260518000001 says the compaction cron is kept "so payloads on
-- lingering-but-soon-to-die rows get nulled out half a day before their
-- partition is dropped". That was true at 14 day retention and has been false
-- since. Anyone reasoning about payload exposure would read it and conclude
-- there is a second line of defence scrubbing payloads. There is not: the only
-- thing removing them is the 7 day truncation, and if that slips, nothing else
-- fires. That earlier migration is left as the historical record it is; this
-- one supersedes its claim.
--
-- Nothing else needs updating: pg-cron-watch derives what it watches from
-- cron.job itself rather than a hand-written list, so the job simply stops
-- being watched.

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  -- Keyed on jobname to find it, then unscheduled BY JOBID, which is the true
  -- identity (a rescheduled job keeps its name and gets a new id).
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'compact-execution-payloads';

  IF v_jobid IS NULL THEN
    -- Absence is reported, not treated as success. An unschedule that matched
    -- nothing and a job that was there and is now gone are different outcomes,
    -- and only one of them means this migration did anything (L100, L98).
    RAISE NOTICE 'compact-execution-payloads: already absent, nothing unscheduled';
  ELSE
    PERFORM cron.unschedule(v_jobid);
    RAISE NOTICE 'compact-execution-payloads: unscheduled jobid %', v_jobid;
  END IF;
END $$;

-- Read back, so the migration proves the end state rather than asserting it.
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining FROM cron.job WHERE jobname = 'compact-execution-payloads';
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'compact-execution-payloads is still scheduled (% rows in cron.job)', v_remaining;
  END IF;
  RAISE NOTICE 'verified: compact-execution-payloads is no longer scheduled';
END $$;
