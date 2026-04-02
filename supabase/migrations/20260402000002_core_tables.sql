-- ============================================================
-- Core tables
-- ============================================================

-- RLS anchor: every other table scopes to this
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Application-level user record linked 1:1 to auth.users
CREATE TABLE users (
  id              UUID PRIMARY KEY,  -- matches auth.users.id
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email           TEXT NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helper: returns the calling user's org ID — used in RLS policies
CREATE OR REPLACE FUNCTION auth.user_org_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT organization_id FROM public.users WHERE id = auth.uid()
$$;

-- Trigger to keep users.updated_at current
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Workflow tables
-- ============================================================

CREATE TABLE workflows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  description      TEXT,
  definition       JSONB NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID REFERENCES users(id),
  updated_by       UUID REFERENCES users(id),
  updated_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER workflows_updated_at
  BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workflow_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  definition     JSONB NOT NULL,
  commit_sha     TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  message        TEXT,
  UNIQUE (workflow_id, version_number)
);

-- ============================================================
-- Execution tables (partitioned by month on started_at)
-- ============================================================

-- Parent table: partitioned by month
CREATE TABLE workflow_executions (
  id                   UUID NOT NULL DEFAULT gen_random_uuid(),
  workflow_id          UUID NOT NULL REFERENCES workflows(id),
  workflow_version_id  UUID REFERENCES workflow_versions(id),
  parent_execution_id  UUID,           -- self-ref; no FK constraint across partitions
  source               TEXT,           -- e.g. 'wallet_owl', 'website_form'
  trigger_type         TEXT NOT NULL DEFAULT 'http_webhook',
  trigger_payload      JSONB,
  status               TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running','completed','failed','exited')),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  duration_ms          INTEGER,
  response_body        JSONB,
  error_message        TEXT,
  trace_id             TEXT,
  is_test              BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

-- execution_steps: partitioned independently; FK to workflow_executions via (execution_id, execution_started_at)
CREATE TABLE execution_steps (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  execution_id          UUID NOT NULL,
  execution_started_at  TIMESTAMPTZ NOT NULL, -- denormalized to satisfy partitioned FK
  step_namespace        TEXT NOT NULL,
  step_type             TEXT NOT NULL
                          CHECK (step_type IN ('code','filter','branch','parallel','partner_bid','integration','transform','bid_evaluation','response','exit')),
  status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed','skipped','failed_with_fallback')),
  input                 JSONB,
  output                JSONB,
  error_message         TEXT,
  error_type            TEXT CHECK (error_type IN ('transient','permanent', NULL)),
  retries_used          INTEGER NOT NULL DEFAULT 0,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,
  step_order            INTEGER,
  parallel_group_id     TEXT,
  PRIMARY KEY (id, started_at),
  FOREIGN KEY (execution_id, execution_started_at)
    REFERENCES workflow_executions(id, started_at)
) PARTITION BY RANGE (started_at);

-- ============================================================
-- Create monthly partitions (2026-01 through 2027-06)
-- ============================================================

DO $$
DECLARE
  start_month DATE := '2026-01-01';
  end_month   DATE;
  i           INTEGER;
  suffix      TEXT;
BEGIN
  FOR i IN 0..17 LOOP
    end_month := start_month + INTERVAL '1 month';
    suffix    := TO_CHAR(start_month, 'YYYY_MM');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS workflow_executions_%s
       PARTITION OF workflow_executions
       FOR VALUES FROM (%L) TO (%L)',
      suffix, start_month, end_month
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS execution_steps_%s
       PARTITION OF execution_steps
       FOR VALUES FROM (%L) TO (%L)',
      suffix, start_month, end_month
    );

    start_month := end_month;
  END LOOP;
END;
$$;

-- ============================================================
-- Remaining tables
-- ============================================================

CREATE TABLE environment_variables (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  key              TEXT NOT NULL,
  value            TEXT,           -- null for secrets (live in Cloudflare)
  is_secret        BOOLEAN NOT NULL DEFAULT false,
  scope            TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','workflow')),
  workflow_id      UUID REFERENCES workflows(id) ON DELETE CASCADE,
  created_by       UUID REFERENCES users(id),
  updated_by       UUID REFERENCES users(id),
  updated_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key, scope, workflow_id)
);

CREATE TRIGGER environment_variables_updated_at
  BEFORE UPDATE ON environment_variables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  service_type     TEXT NOT NULL CHECK (service_type IN ('salesforce','supabase','snowflake')),
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('oauth','api_key','credentials')),
  cf_secret_key    TEXT NOT NULL,  -- name of Cloudflare Worker secret holding credentials
  user_id          UUID REFERENCES users(id),  -- null = shared connection
  schema_cache     JSONB,
  schema_synced_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID REFERENCES users(id),
  updated_by_email TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER service_connections_updated_at
  BEFORE UPDATE ON service_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE partner_configs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id),
  name                     TEXT NOT NULL,
  slug                     TEXT UNIQUE NOT NULL,  -- used in DO IDs, node configs, logs
  api_endpoint             TEXT,
  cf_secret_key            TEXT,                  -- Cloudflare Worker secret name
  daily_cap                INTEGER,
  min_bid                  DECIMAL,
  bid_formula              TEXT,                  -- e.g. 'debt_amount * 0.65'
  dedup_endpoint           TEXT,
  response_classification  JSONB,                 -- per-partner signal overrides (Section 11.2)
  alert_config             JSONB,                 -- per-partner alert tuning (Section 11.5)
  circuit_error_threshold  INTEGER NOT NULL DEFAULT 5,
  circuit_window_seconds   INTEGER NOT NULL DEFAULT 60,
  circuit_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  circuit_enabled          BOOLEAN NOT NULL DEFAULT true,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  priority                 INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               UUID REFERENCES users(id),
  updated_by_email         TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER partner_configs_updated_at
  BEFORE UPDATE ON partner_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reporting only — cap enforcement is in Durable Objects
CREATE TABLE partner_daily_counts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partner_configs(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, date)
);

-- Append-only audit trail for all mutations
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  entity_type     TEXT NOT NULL
                    CHECK (entity_type IN ('partner_config','environment_variable','service_connection','workflow','circuit_breaker')),
  entity_id       UUID NOT NULL,
  action          TEXT NOT NULL
                    CHECK (action IN ('created','updated','deleted','circuit_force_closed','secret_rotated')),
  changed_by      UUID REFERENCES users(id),
  changes         JSONB,  -- before/after snapshot; secret values never stored
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
