-- ============================================================
-- Achieve (FDR) evaluations log
-- ============================================================
-- One row per Achieve Partners API call made from a workflow (the
-- achieve_fdr code node). Stores the lead payload sent and the offers
-- returned so the team can analyze potential volume / lead types and
-- later join against trades data (by trace_id / execution_id /
-- submission_id). Written by the engine in waitUntil after the walk
-- completes; failures never block the workflow.
--
-- Partitioned monthly like lead_sightings so old months can be
-- partition-dropped (or exported to Snowflake via exported_at) without
-- bloating disk. request_payload has SSN/DOB redacted at write time.
-- ============================================================

CREATE TABLE achieve_evaluations (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  trace_id            VARCHAR NOT NULL,
  execution_id        UUID NOT NULL,
  workflow_id         UUID NOT NULL REFERENCES workflows(id),
  node_namespace      VARCHAR NOT NULL,
  submission_id       VARCHAR,                       -- Salesforce Submission__c

  requested_at_utc    TIMESTAMP NOT NULL,            -- step started_at (partition key)
  duration_ms         INTEGER,
  http_status         INTEGER,
  response_status     VARCHAR,                       -- 'accepted' | 'rejected' | 'error'
  response_reason     VARCHAR,
  offer_count         INTEGER NOT NULL DEFAULT 0,

  request_payload     JSONB,                         -- lead info sent (SSN/DOB redacted)
  response_body       JSONB,                         -- full Achieve response
  offers              JSONB,                         -- offers array from response

  is_test             BOOLEAN NOT NULL DEFAULT FALSE,
  exported_at         TIMESTAMPTZ,                   -- null until pushed to Snowflake (future)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id, requested_at_utc)
) PARTITION BY RANGE (requested_at_utc);

CREATE INDEX achieve_evaluations_execution_idx ON achieve_evaluations (execution_id);
CREATE INDEX achieve_evaluations_trace_idx ON achieve_evaluations (trace_id);
CREATE INDEX achieve_evaluations_workflow_idx ON achieve_evaluations (workflow_id, requested_at_utc DESC);
CREATE INDEX achieve_evaluations_submission_idx ON achieve_evaluations (submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX achieve_evaluations_status_idx ON achieve_evaluations (response_status, requested_at_utc DESC);

ALTER TABLE achieve_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "achieve_evaluations_org" ON achieve_evaluations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );

-- Initial monthly partitions: current month + 5 months ahead
-- (matches lead_sightings pattern)
DO $$
DECLARE
  m DATE := date_trunc('month', now())::DATE;
  next_m DATE;
  partition_name TEXT;
BEGIN
  FOR i IN 0..5 LOOP
    next_m := (m + (i || ' months')::interval + interval '1 month')::DATE;
    partition_name := 'achieve_evaluations_' || to_char(m + (i || ' months')::interval, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF achieve_evaluations FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      (m + (i || ' months')::interval)::DATE,
      next_m
    );
  END LOOP;
END $$;


-- ============================================================
-- Monthly partition rollover for analytics tables
-- ============================================================
-- The old create-monthly-partitions cron was unscheduled on 2026-05-22 when
-- the execution tables moved to daily partitions, and the replacement daily
-- cron only covers workflow_executions + execution_steps. That left
-- lead_sightings / lead_sighting_bids with no rollover: their seeded
-- partitions end 2026-09-30 and inserts would start failing on 2026-10-01.
-- This restores monthly rollover for all three analytics tables.
--
-- Low write volume here (a few thousand rows/day), so plain
-- CREATE TABLE IF NOT EXISTS ... PARTITION OF is fine; the standalone
-- build + CHECK + ATTACH dance is only needed on the hot execution tables.
-- Ensures coverage from each table's current max bound out to now() + 3
-- months, so it self-heals if the cron misses a month.

CREATE OR REPLACE FUNCTION create_monthly_analytics_partitions()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_parent TEXT;
  v_month  DATE;
  v_target DATE := (date_trunc('month', now()) + INTERVAL '3 months')::DATE;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['lead_sightings', 'lead_sighting_bids', 'achieve_evaluations'] LOOP
    v_month := date_trunc('month', now())::DATE;
    WHILE v_month <= v_target LOOP
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_parent || '_' || TO_CHAR(v_month, 'YYYY_MM'),
        v_parent,
        v_month,
        (v_month + INTERVAL '1 month')::DATE
      );
      v_month := (v_month + INTERVAL '1 month')::DATE;
    END LOOP;
  END LOOP;
END;
$$;

-- Run once now to top up lead_sightings / lead_sighting_bids coverage.
SELECT create_monthly_analytics_partitions();

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'create-monthly-analytics-partitions'; END $$;

SELECT cron.schedule(
  'create-monthly-analytics-partitions',
  '0 1 1 * *',
  'SELECT create_monthly_analytics_partitions()'
);
