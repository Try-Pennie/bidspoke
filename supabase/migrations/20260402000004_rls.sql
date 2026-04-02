-- ============================================================
-- Row Level Security
-- All tables scoped to the calling user's organization.
-- public.user_org_id() returns the org from public.users for auth.uid().
-- ============================================================

-- organizations: users can only see their own org
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_self" ON organizations
  FOR ALL USING (id = public.user_org_id());

-- users: visible within same org
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_same_org" ON users
  FOR ALL USING (organization_id = public.user_org_id());

-- workflows
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflows_org" ON workflows
  FOR ALL USING (organization_id = public.user_org_id());

-- workflow_versions: scoped via parent workflow
ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "versions_org" ON workflow_versions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );

-- workflow_executions: scoped via parent workflow
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "executions_org" ON workflow_executions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );

-- execution_steps: scoped via parent execution → workflow
ALTER TABLE execution_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "steps_org" ON execution_steps
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflow_executions e
      JOIN workflows w ON w.id = e.workflow_id
      WHERE e.id = execution_id
        AND e.started_at = execution_started_at
        AND w.organization_id = public.user_org_id()
    )
  );

-- environment_variables
ALTER TABLE environment_variables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "env_vars_org" ON environment_variables
  FOR ALL USING (organization_id = public.user_org_id());

-- service_connections
ALTER TABLE service_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "connections_org" ON service_connections
  FOR ALL USING (organization_id = public.user_org_id());

-- partner_configs
ALTER TABLE partner_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "partners_org" ON partner_configs
  FOR ALL USING (organization_id = public.user_org_id());

-- partner_daily_counts: scoped via parent partner_config
ALTER TABLE partner_daily_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_counts_org" ON partner_daily_counts
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM partner_configs p
      WHERE p.id = partner_id
        AND p.organization_id = public.user_org_id()
    )
  );

-- audit_log: read-only for users; insert only from service role (worker)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_read" ON audit_log
  FOR SELECT USING (organization_id = public.user_org_id());
-- Inserts are made via the Worker using the service role key, which bypasses RLS
