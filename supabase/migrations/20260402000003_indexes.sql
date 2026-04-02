-- ============================================================
-- Indexes
-- ============================================================

-- workflows
CREATE INDEX idx_workflows_org ON workflows(organization_id);
CREATE INDEX idx_workflows_active ON workflows(organization_id, is_active);

-- workflow_versions
CREATE INDEX idx_workflow_versions_workflow ON workflow_versions(workflow_id);
CREATE INDEX idx_workflow_versions_created ON workflow_versions(workflow_id, version_number DESC);

-- workflow_executions
CREATE INDEX idx_executions_workflow ON workflow_executions(workflow_id, started_at DESC);
CREATE INDEX idx_executions_status ON workflow_executions(status, started_at DESC);
CREATE INDEX idx_executions_trace ON workflow_executions(trace_id);
CREATE INDEX idx_executions_source ON workflow_executions(source, started_at DESC);
CREATE INDEX idx_executions_parent ON workflow_executions(parent_execution_id);

-- execution_steps
CREATE INDEX idx_steps_execution ON execution_steps(execution_id, step_order);
CREATE INDEX idx_steps_parallel_group ON execution_steps(parallel_group_id) WHERE parallel_group_id IS NOT NULL;
CREATE INDEX idx_steps_status ON execution_steps(execution_id, status);

-- environment_variables
CREATE INDEX idx_env_vars_org ON environment_variables(organization_id);
CREATE INDEX idx_env_vars_workflow ON environment_variables(workflow_id) WHERE workflow_id IS NOT NULL;

-- service_connections
CREATE INDEX idx_connections_org ON service_connections(organization_id);

-- partner_configs
CREATE INDEX idx_partners_org ON partner_configs(organization_id);
CREATE INDEX idx_partners_active ON partner_configs(organization_id, is_active, priority);

-- partner_daily_counts
CREATE INDEX idx_daily_counts_date ON partner_daily_counts(partner_id, date DESC);

-- audit_log
CREATE INDEX idx_audit_org_time ON audit_log(organization_id, changed_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, changed_at DESC);
CREATE INDEX idx_audit_user ON audit_log(changed_by, changed_at DESC);
