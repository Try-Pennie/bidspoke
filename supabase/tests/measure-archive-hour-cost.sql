-- Re-take what an hour of archiving costs (#953, #1041).
--
-- WHY THIS FILE EXISTS. The budget arithmetic in apps/worker/src/archive/
-- deadline.ts once rested on a flat "257 seconds per hour", measured from a
-- single recovery run on 2026-08-22. An hour's cost is not a property of the
-- archive, it is a property of how much traffic that hour held, so the constant
-- drifted as the business grew and it drifted GREEN, which is the direction
-- nobody checks (L323, L354). A dated number in a comment is trusted more as it
-- ages, not less, so the premise is recorded here in a form somebody can
-- re-measure rather than as a sentence with a date on it (L316, L61).
--
-- Every statement is a PURE READ of public.job_runs. It creates nothing, writes
-- nothing and takes no lock, so it is safe against production, and production is
-- where it belongs: these are figures about production's own traffic.
--
-- WHAT TO DO WITH THE RESULTS. Query 1 feeds the four constants in
-- apps/worker/src/lib/__tests__/execution-archive.test.ts. If query 3 shows the
-- busiest hour approaching the wall budget, that is the finding: the reserve
-- refuses to start an hour it cannot finish, so an hour too expensive to fit
-- means the run archives NOTHING, and a run that archives nothing looks exactly
-- like a run with nothing to do (L98).

-- ---------------------------------------------------------------------------
-- 1. Cost per execution, which is the unit that stays true as volume grows.
-- ---------------------------------------------------------------------------
-- Only single-hour runs, so the duration divides by a known number of hours.
-- Only hours with real volume, because a near-empty hour is all fixed overhead
-- and its per-execution rate is meaningless.
WITH r AS (
  SELECT extract(epoch FROM (finished_at - started_at)) * 1000 AS ms,
         (summary->>'executionsArchived')::int                 AS execs
  FROM public.job_runs
  WHERE job = 'execution-archive'
    AND finished_at IS NOT NULL
    AND (summary->>'hoursArchived')::int = 1
    AND started_at > now() - interval '7 days'
    AND (summary->>'executionsArchived')::int > 200
)
SELECT count(*)                                                                        AS runs,
       round(avg(ms / execs)::numeric, 1)                                              AS mean_ms_per_exec,
       round((percentile_cont(0.95) WITHIN GROUP (ORDER BY ms / execs))::numeric, 1)   AS p95_ms_per_exec,
       round(max(ms / execs)::numeric, 1)                                              AS worst_ms_per_exec,
       round(avg(execs))                                                               AS mean_hour_executions,
       max(execs)                                                                      AS busiest_hour_executions,
       -- Near 1.0 means cost is linear in volume, which is what licenses the
       -- per-execution unit at all. It was 0.937 on 2026-09-10. If this falls
       -- away from 1, something other than volume has started driving the cost
       -- and the whole model below needs rethinking rather than re-fitting.
       round(corr(execs, ms)::numeric, 3)                                              AS corr_volume_cost
FROM r;

-- ---------------------------------------------------------------------------
-- 2. The shape of the day, which is why one flat number could never hold.
-- ---------------------------------------------------------------------------
-- `hours_that_fit` is how many hours of that cost the wall budget can hold. The
-- cap is the control wherever this is 3 or more, and the wall budget is the
-- control wherever it is less. Measured 2026-09-10: 3 or more for the quiet
-- half of the day, 1 to 2 through the afternoon and evening peak.
--
-- Change the 780 if CRON_RUN_BUDGET.wallMs changes; it is 13 minutes today.
WITH r AS (
  SELECT extract(hour FROM started_at)::int                    AS run_hour_utc,
         extract(epoch FROM (finished_at - started_at))        AS secs,
         (summary->>'executionsArchived')::int                 AS execs
  FROM public.job_runs
  WHERE job = 'execution-archive'
    AND finished_at IS NOT NULL
    AND (summary->>'hoursArchived')::int = 1
    AND started_at > now() - interval '7 days'
)
SELECT run_hour_utc,
       count(*)                                       AS runs,
       round(avg(secs)::numeric)                      AS mean_s,
       round(max(secs)::numeric)                      AS worst_s,
       round(avg(execs))                              AS mean_executions,
       floor(780.0 / greatest(max(secs), 1))::int     AS hours_that_fit
FROM r
GROUP BY run_hour_utc
ORDER BY run_hour_utc;

-- ---------------------------------------------------------------------------
-- 3. The limit that actually binds: can a run still finish the busiest hour?
-- ---------------------------------------------------------------------------
-- Headroom is stated as a RATIO rather than spare seconds, so it keeps its
-- meaning when either side moves. Below about 1.25 the guard in
-- execution-archive.test.ts fails, deliberately, while there is still room to
-- act. Below 1.0 the archive cannot advance at peak at all.
WITH r AS (
  SELECT extract(epoch FROM (finished_at - started_at)) * 1000 AS ms,
         (summary->>'executionsArchived')::int                 AS execs
  FROM public.job_runs
  WHERE job = 'execution-archive'
    AND finished_at IS NOT NULL
    AND (summary->>'hoursArchived')::int = 1
    AND started_at > now() - interval '7 days'
    AND (summary->>'executionsArchived')::int > 200
),
rates AS (
  SELECT max(execs)                                                        AS busiest,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY ms / execs)          AS p95_rate
  FROM r
)
SELECT busiest                                                       AS busiest_hour_executions,
       round(p95_rate::numeric, 1)                                   AS p95_ms_per_exec,
       round((busiest * p95_rate / 1000)::numeric)                   AS busiest_hour_cost_s,
       780                                                           AS wall_budget_s,
       round((780000.0 / (busiest * p95_rate))::numeric, 2)          AS headroom_ratio,
       round(((780000.0 / (busiest * p95_rate)) - 1) * 100)          AS growth_room_pct
FROM rates;
