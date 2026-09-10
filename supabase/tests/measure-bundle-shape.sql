-- Re-take the volume and bundle-shape figures ADR 0009 records (#891, #886).
--
-- WHY THIS FILE EXISTS. The ADR's A0 measurements came from 60 executions on a
-- single day and nothing re-runs them. A dated number in a document is trusted
-- MORE as it ages, not less, so recording the date was never going to be enough:
-- the premise has to be recorded in a form somebody can re-measure (L316, L61).
--
-- Every statement here is a PURE READ. It creates nothing, writes nothing and
-- takes no lock, so it is safe to run against production and that is where it
-- belongs: the figures are about production's own traffic, and a branch would
-- describe a database with none.
--
-- WHAT IT CANNOT ANSWER. Everything on the ARCHIVE side: compression ratio, wire
-- size, stored bytes, credits. Those live in Snowflake behind the Worker's
-- credentials and cannot be reached from a SQL session. The single most
-- important unmeasured number is the MEAN compression ratio, because the storage
-- total turns on it and only p50, p95 and p99 were ever taken.

-- ---------------------------------------------------------------------------
-- 1. Volume, from the gate's own daily measurements.
-- ---------------------------------------------------------------------------
-- Compare against the ADR's "~105,000 executions/day" and "11.9 steps per
-- execution". Only days with executions, so an empty day does not drag the
-- average toward zero and read as a traffic collapse.
SELECT
  round(avg(pg_execution_count))                                        AS executions_per_day,
  round(avg(pg_step_count))                                             AS steps_per_day,
  round(avg(pg_step_count::numeric / nullif(pg_execution_count, 0)), 1) AS steps_per_execution,
  count(*)                                                              AS days_averaged,
  min(archive_day)                                                      AS from_day,
  max(archive_day)                                                      AS to_day
FROM public.execution_archive_days
WHERE pg_execution_count > 0;

-- ---------------------------------------------------------------------------
-- 2. Bundle shape, sampled ACROSS days and hours.
-- ---------------------------------------------------------------------------
-- The windows are deliberately spread. The original figures came from one day,
-- and a bundle's size follows what the workflow did, so a single busy window
-- measures that window rather than the population.
--
-- THE MEAN IS THE POINT. A total is computed from the mean; the ADR's 435 GB
-- was computed from the p50, and this distribution's mean is more than double
-- its median, so half the bytes live in the tail. Both are reported here so the
-- next reader cannot repeat that (L107).
--
-- Move the four dates forward before running: they must fall inside the
-- retention window or the sample is empty, and an empty sample reports NULL
-- rather than anything alarming.
WITH windows(w_start) AS (
  VALUES (timestamptz '2026-09-05 03:00:00+00'),
         (timestamptz '2026-09-06 11:00:00+00'),
         (timestamptz '2026-09-08 16:00:00+00'),
         (timestamptz '2026-09-09 21:00:00+00')
),
sample AS (
  SELECT e.id, e.started_at
  FROM windows w
  JOIN LATERAL (
    SELECT id, started_at
    FROM public.workflow_executions
    WHERE started_at >= w.w_start
      AND started_at <  w.w_start + interval '5 minutes'
    LIMIT 250
  ) e ON true
),
sized AS (
  -- The bundle is the execution row plus its steps, which is what the archiver
  -- encodes, so this measures the same thing rather than a proxy for it.
  SELECT octet_length(to_jsonb(e)::text)
         + coalesce((SELECT sum(octet_length(to_jsonb(st)::text))
                     FROM public.execution_steps st
                     WHERE st.execution_id = s.id
                       AND st.started_at >= s.started_at), 0) AS bytes
  FROM sample s
  JOIN public.workflow_executions e ON e.id = s.id AND e.started_at = s.started_at
)
SELECT
  count(*)                                                                          AS sampled,
  round(avg(bytes)::numeric / 1024, 1)                                              AS mean_kb,
  round((percentile_cont(0.50) WITHIN GROUP (ORDER BY bytes))::numeric / 1024, 1)   AS p50_kb,
  round((percentile_cont(0.95) WITHIN GROUP (ORDER BY bytes))::numeric / 1024, 1)   AS p95_kb,
  round((percentile_cont(0.99) WITHIN GROUP (ORDER BY bytes))::numeric / 1024, 1)   AS p99_kb,
  -- Above 2 means the mean is more than double the median, so any total computed
  -- from the p50 is materially low. It was 2.3 on 2026-09-10.
  round((avg(bytes) / nullif(percentile_cont(0.50) WITHIN GROUP (ORDER BY bytes), 0))::numeric, 2)
    AS mean_over_median
FROM sized;

-- ---------------------------------------------------------------------------
-- 3. The projection, so the arithmetic is not redone by hand each time.
-- ---------------------------------------------------------------------------
-- Feed it the two numbers above. It uses the MEAN deliberately, and takes the
-- compression ratio as an argument because that is the figure nobody has
-- measured at the mean: run it at 4.0 (the measured p50 ratio, conservative)
-- and again at a higher one to see the range the real answer sits in.
SELECT
  executions_per_day,
  mean_kb,
  compression,
  round((executions_per_day * mean_kb / compression * 1.33 / 1024 / 1024)::numeric, 2)      AS wire_gb_per_day,
  round((executions_per_day * mean_kb / compression * 1.33 / 1024 / 1024 * 395)::numeric)   AS gb_at_13_months
FROM (VALUES (94964::numeric, 77.2::numeric)) AS measured(executions_per_day, mean_kb),
     (VALUES (4.0::numeric), (6.0::numeric), (8.0::numeric)) AS assumed(compression);
