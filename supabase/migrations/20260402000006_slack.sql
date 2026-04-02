-- Phase 1.7: Slack integration support

-- Extend service_connections to support slack (drop and recreate the check constraint)
ALTER TABLE service_connections
  DROP CONSTRAINT IF EXISTS service_connections_service_type_check;

ALTER TABLE service_connections
  ADD CONSTRAINT service_connections_service_type_check
  CHECK (service_type IN ('salesforce', 'supabase', 'snowflake', 'slack'));

-- Store service-specific metadata (workspace name, default channel, encrypted token for non-CF-secrets services)
ALTER TABLE service_connections
  ADD COLUMN IF NOT EXISTS config JSONB;

-- Per-workflow Slack channel override (empty = use org default from service_connections)
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS slack_channel TEXT;
