-- A durable record that a scheduled run started, and whether it finished
-- (#960).
--
-- WHY. The only way to tell a KILLED archive run from a run that had nothing to
-- do was the presence of its KV lock, and that self-expires. Nothing recorded
-- that a run started and never came back: the heartbeat stamps only the start,
-- and a run that dies leaves the watermark, execution_archive_ids and
-- execution_archive_refusals all untouched, which is exactly what an hour with
-- no work looks like. On 2026-08-21 the window in which the distinction was
-- observable at all was hit once and missed twice, purely on timing, and only by
-- somebody reading KV by hand.
--
-- A killed run therefore leaves a row here with finished_at NULL, permanently.
-- That is the whole design: the absence of an ending is the evidence, and it
-- does not expire.
--
-- DELIBERATELY NOT ARCHIVE SPECIFIC. #745 asks for the same thing for the export
-- and purge jobs, and two tables recording "a job ran" would drift. `job` is a
-- free text id so a job can join without a migration.
--
-- VOLUME: the archive runs hourly, so 24 rows a day, about 8,800 a year. Small
-- enough that no retention job is worth the moving part, and stated here so the
-- next person does not have to work it out.

CREATE TABLE IF NOT EXISTS public.job_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job          TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL means the run never came back. Not an error state on its own: a run
  -- currently in flight looks the same, which is why the reader compares
  -- started_at against how long that job may legitimately take.
  finished_at  TIMESTAMPTZ,
  -- The run's own stop reason, so a clean stop and a failure are distinguishable
  -- without parsing prose.
  outcome      TEXT,
  detail       TEXT,
  -- Whatever counts the job reports. JSONB so a job can add one without a
  -- migration, and so this table never becomes a second schema to keep in step.
  summary      JSONB
);

CREATE INDEX IF NOT EXISTS job_runs_job_started_idx ON public.job_runs (job, started_at DESC);

-- Finding the killed runs is the query this exists for, so it gets its own
-- partial index rather than scanning every run ever recorded.
CREATE INDEX IF NOT EXISTS job_runs_unfinished_idx
  ON public.job_runs (job, started_at DESC)
  WHERE finished_at IS NULL;

COMMENT ON TABLE public.job_runs IS
  'One row per scheduled run, started and finished stamped separately (#960). A row with finished_at NULL and a start older than the job can take is a run that was killed.';

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_runs FROM PUBLIC, anon, authenticated;
