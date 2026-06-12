-- Issue #87: workflow_stats_daily had no RLS and no policy, unlike every other
-- table in the schema. Org scoping lived only inside the workflow_stats_rollup
-- RPC's WHERE clause. Because authenticated relies on schema-level grants here,
-- a logged-in user could bypass the RPC and read/alter/delete every org's run
-- counts, durations, and cost_usd_sum directly via PostgREST.
--
-- The table has workflow_id (no organization_id), so scope via the workflows
-- join — identical to the lead_sightings policy. The worker reads through the
-- RPC with the service_role key (bypasses RLS), and the pg_cron refresh runs as
-- postgres (bypasses RLS), so neither path is affected.

ALTER TABLE workflow_stats_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_stats_daily_org" ON workflow_stats_daily
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );
