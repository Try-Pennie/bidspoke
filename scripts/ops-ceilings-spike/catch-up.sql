-- scripts/ops-ceilings-spike/catch-up.sql (#1946, Spike 0 S0.1b): the catch-up
-- backlog an ops run engine tick would have to drain after an outage, modelled on
-- SYNTHETIC rows in a throwaway local Postgres. Run by catch-up.sh, never against
-- a real database: it creates and drops its own schema, spike_1946.
--
-- The tables are a MODEL of the #1698 design (schedules, run_requests,
-- run_queue), not B1's schema, which does not exist yet. What it measures:
--   1. how many rows each catch-up read returns, against PostgREST's 1,000 row cap;
--   2. how long each statement takes under service_role's 30 s statement_timeout;
--   3. how those move with the outage length and the history kept.
-- Every input is a psql variable, so a re-run with the real numbers (B1's schema,
-- the measured schedule periods and arrival rate) is one command.
--
-- Inputs (defaults are stated bounds, not measurements; see docs/ops-ceilings-spike.md):
--   schedules      switched on timer workflows in the Pipedream export (68)
--   period_s       the shortest period assumed for every one of them (60 s, the worst case)
--   outage_h       hours the tick did not run (6)
--   arrivals_day   run requests a day across the ported workflows (50000, modelled)
--   history_days   terminal rows kept in run_requests (30, the #1948 EXPLAIN condition)
--   workflows      distinct workflows the queued runs belong to (300)
--   inflight       runs holding a lease when the Worker died (500)
--   k              per workflow claim cap per call (5)
--   claim_limit    total claim per call (100)
\set ON_ERROR_STOP 1
\if :{?schedules} \else \set schedules 68 \endif
\if :{?period_s} \else \set period_s 60 \endif
\if :{?outage_h} \else \set outage_h 6 \endif
\if :{?arrivals_day} \else \set arrivals_day 50000 \endif
\if :{?history_days} \else \set history_days 30 \endif
\if :{?workflows} \else \set workflows 300 \endif
\if :{?inflight} \else \set inflight 500 \endif
\if :{?k} \else \set k 5 \endif
\if :{?claim_limit} \else \set claim_limit 100 \endif

SET client_min_messages = warning;
DROP SCHEMA IF EXISTS spike_1946 CASCADE;
CREATE SCHEMA spike_1946;
SET search_path = spike_1946, public;

CREATE TABLE schedules (
  workflow_id int PRIMARY KEY,
  organization_id uuid NOT NULL,
  period_s int NOT NULL,
  last_fired_at timestamptz NOT NULL
);
CREATE TABLE run_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  workflow_id int NOT NULL,
  status text NOT NULL,
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  claim_token uuid,
  lease_expires_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX run_requests_lease ON run_requests (lease_expires_at, id) WHERE status = 'running';
CREATE TABLE run_queue (
  run_request_id bigint PRIMARY KEY,
  workflow_id int NOT NULL,
  not_before timestamptz NOT NULL,
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);
CREATE INDEX run_queue_claim ON run_queue (workflow_id, priority DESC, created_at, run_request_id);

-- The tick's clock: everything below is relative to one literal instant, as the
-- #1698 design passes literal bounds (L739).
CREATE TEMP TABLE clock AS SELECT now() AS t;

-- Schedules, all last fired when the outage began.
INSERT INTO schedules
SELECT g, '00000000-0000-4000-8000-000000000001', :period_s, (SELECT t FROM clock) - make_interval(hours => :outage_h)
FROM generate_series(1, :schedules) g;

-- History: terminal rows over history_days at arrivals_day.
INSERT INTO run_requests (organization_id, workflow_id, status, created_at, finished_at)
SELECT '00000000-0000-4000-8000-000000000001', 1 + (g % :workflows), 'succeeded',
       (SELECT t FROM clock) - make_interval(secs => g * (86400.0 / :arrivals_day)) - make_interval(hours => :outage_h),
       (SELECT t FROM clock) - make_interval(secs => g * (86400.0 / :arrivals_day)) - make_interval(hours => :outage_h)
FROM generate_series(1, (:arrivals_day * :history_days)::int) g;

-- The runs that arrived while the tick was down, queued and unclaimed.
WITH arrived AS (
  INSERT INTO run_requests (organization_id, workflow_id, status, created_at)
  SELECT '00000000-0000-4000-8000-000000000001', 1 + (g % :workflows), 'queued',
         (SELECT t FROM clock) - make_interval(secs => g * (86400.0 / :arrivals_day))
  FROM generate_series(1, (:arrivals_day * :outage_h / 24.0)::int) g
  RETURNING id, workflow_id, created_at
)
INSERT INTO run_queue SELECT id, workflow_id, created_at, 0, created_at FROM arrived;

-- The runs that held a lease when the Worker died: every lease has expired.
INSERT INTO run_requests (organization_id, workflow_id, status, created_at, claim_token, lease_expires_at)
SELECT '00000000-0000-4000-8000-000000000001', 1 + (g % :workflows), 'running',
       (SELECT t FROM clock) - make_interval(hours => :outage_h, mins => 2), gen_random_uuid(),
       (SELECT t FROM clock) - make_interval(hours => :outage_h, mins => 1)
FROM generate_series(1, :inflight) g;

ANALYZE schedules; ANALYZE run_requests; ANALYZE run_queue;

-- One statement, timed by EXPLAIN ANALYZE under the service_role timeout, its
-- row count read from the plan's top node.
CREATE FUNCTION measure(label text, stmt text) RETURNS TABLE (measure text, rows_returned bigint, pages_of_1000 bigint, ms numeric)
LANGUAGE plpgsql AS $$
DECLARE plan json;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || stmt INTO plan;
  measure := label;
  rows_returned := (plan -> 0 -> 'Plan' ->> 'Actual Rows')::numeric::bigint;
  pages_of_1000 := ceil(rows_returned / 1000.0)::bigint;
  ms := round((plan -> 0 ->> 'Execution Time')::numeric, 1);
  RETURN NEXT;
END $$;

SET statement_timeout = '30s';

\echo 'inputs: schedules=' :schedules ' period_s=' :period_s ' outage_h=' :outage_h ' arrivals_day=' :arrivals_day ' history_days=' :history_days ' workflows=' :workflows ' inflight=' :inflight ' k=' :k ' claim_limit=' :claim_limit
SELECT (SELECT count(*) FROM run_requests) AS run_requests_rows, (SELECT count(*) FROM run_queue) AS queued_rows,
       pg_size_pretty(pg_total_relation_size('spike_1946.run_requests')) AS run_requests_size;

SELECT * FROM measure('every missed fire, materialised (no catch_up limit)', format($q$
  SELECT s.workflow_id, f AS scheduled_for
  FROM spike_1946.schedules s,
       generate_series(s.last_fired_at + make_interval(secs => s.period_s), %L::timestamptz, make_interval(secs => s.period_s)) f
$q$, (SELECT t FROM clock)))
UNION ALL
SELECT * FROM measure('the latest missed fire per schedule (catch_up latest)', format($q$
  SELECT s.workflow_id, s.last_fired_at + make_interval(secs => s.period_s * floor(extract(epoch FROM %L::timestamptz - s.last_fired_at) / s.period_s)::int)
  FROM spike_1946.schedules s WHERE s.last_fired_at + make_interval(secs => s.period_s) <= %L::timestamptz
$q$, (SELECT t FROM clock), (SELECT t FROM clock)))
UNION ALL
SELECT * FROM measure('expired leases, whole set (the sweep''s worst case)', format($q$
  SELECT id FROM spike_1946.run_requests WHERE status = 'running' AND lease_expires_at < %L::timestamptz ORDER BY lease_expires_at, id
$q$, (SELECT t FROM clock)))
UNION ALL
SELECT * FROM measure('queued runs, whole backlog', $q$ SELECT run_request_id FROM spike_1946.run_queue $q$)
UNION ALL
SELECT * FROM measure('fair claim, one call (CTE + LATERAL + SKIP LOCKED)', format($q$
  WITH wf AS (SELECT DISTINCT workflow_id FROM spike_1946.run_queue WHERE not_before <= %L::timestamptz),
  picked AS (
    SELECT q.run_request_id FROM wf
    CROSS JOIN LATERAL (
      SELECT run_request_id FROM spike_1946.run_queue q
      WHERE q.workflow_id = wf.workflow_id AND q.not_before <= %L::timestamptz
      ORDER BY q.priority DESC, q.created_at, q.run_request_id
      LIMIT %s FOR UPDATE SKIP LOCKED
    ) q
    LIMIT %s
  )
  DELETE FROM spike_1946.run_queue rq USING picked WHERE rq.run_request_id = picked.run_request_id RETURNING rq.run_request_id
$q$, (SELECT t FROM clock), (SELECT t FROM clock), :k, :claim_limit))
UNION ALL
-- The first sweep after the outage reads back to the last one that ran, so its
-- window is the outage plus the 24 h before it (nothing finished during the outage).
SELECT * FROM measure('reconciliation read: the outage plus the 24 h before it, NO index', format($q$
  SELECT id FROM spike_1946.run_requests WHERE finished_at >= %L::timestamptz - make_interval(hours => %s + 24)
$q$, (SELECT t FROM clock), :outage_h));

RESET statement_timeout;
DROP SCHEMA spike_1946 CASCADE;
