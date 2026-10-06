-- The Pipedream inventory and workflow map, in their own `porting` schema (#1710,
-- plan 0.F, plan 0.2 in Discussion #1684).
--
-- porting.pipedream_inventory: one row per Pipedream workflow in any export loaded
-- by scripts/porting/load-inventory.ts. Two facts never share a field (L53):
--   pipedream_state  what the newest export says ('on', 'off', 'never_deployed'),
--                    written only by the loader;
--   porting_stage    how far Bidspoke has taken it, advanced only by Bidspoke and
--                    never written by the loader.
-- A workflow a newer export of its project no longer lists is kept and stamped
-- absent_since_export_at, never deleted: the row may carry a porting_stage.
--
-- porting.pipedream_workflow_map: which Bidspoke workflow stands for which
-- Pipedream one. A plain workflow has one 'whole' row; a split workflow has one
-- 'body' row and one 'shell' row per trigger. trigger_index is NOT NULL so the
-- unique constraint cannot be defeated by NULLs (L393), and 0 for whole and body.
--
-- Neither table is for the browser: RLS on with no policy, and every privilege
-- revoked from anon and authenticated by name (L124, L541). Only the service role
-- reads and writes them.
--
-- The Data API: the schema is added to PostgREST's exposed schemas here, in the
-- database, so the setting lives in git rather than in the dashboard. Measured
-- 2026-10-06 before this change: the API exposed exactly public and graphql_public
-- (a PGRST106 probe lists them). Once this role setting exists the dashboard's
-- "Exposed schemas" field no longer governs the list (Supabase, "PGRST002"
-- troubleshooting guide): change it with ALTER ROLE in a migration, never there.
--
-- Additive only (ADR 0007): a new schema and two new tables.

SET LOCAL lock_timeout = '5s';

CREATE SCHEMA porting;
REVOKE ALL ON SCHEMA porting FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA porting TO service_role;

CREATE TABLE porting.pipedream_inventory (
  pipedream_hashid text PRIMARY KEY CHECK (pipedream_hashid ~ '^p_[A-Za-z0-9]+$'),
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  project_hashid text NOT NULL CHECK (project_hashid ~ '^proj_[A-Za-z0-9]+$'),
  name text NOT NULL,
  pipedream_state text NOT NULL CHECK (pipedream_state IN ('on', 'off', 'never_deployed')),
  porting_stage text NOT NULL DEFAULT 'none' CHECK (porting_stage IN ('none', 'drafted', 'cut_over', 'settled')),
  definition_sha256 text CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
  trigger_types text[] NOT NULL DEFAULT '{}',
  step_count integer NOT NULL CHECK (step_count >= 0),
  deployment_count integer NOT NULL CHECK (deployment_count >= 0),
  first_seen_export_at timestamptz NOT NULL,
  last_seen_export_at timestamptz NOT NULL,
  absent_since_export_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen_export_at >= first_seen_export_at),
  CHECK (absent_since_export_at IS NULL OR absent_since_export_at > last_seen_export_at)
);

CREATE INDEX pipedream_inventory_organization_id_idx ON porting.pipedream_inventory (organization_id);
CREATE INDEX pipedream_inventory_project_hashid_idx ON porting.pipedream_inventory (project_hashid);

COMMENT ON TABLE porting.pipedream_inventory IS
  'One row per Pipedream workflow seen in a loaded export (#1710). pipedream_state is what the newest export of its project says and is written only by scripts/porting/load-inventory.ts; porting_stage is advanced only by Bidspoke and never by the loader (L53). definition_sha256 is the hash of the workflow file in that export (null for never deployed, which has no file), the snapshot a port is built from. absent_since_export_at is set when a newer export of the project no longer lists the workflow; the row is never deleted.';

CREATE TABLE porting.pipedream_workflow_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipedream_hashid text NOT NULL REFERENCES porting.pipedream_inventory (pipedream_hashid),
  role text NOT NULL CHECK (role IN ('whole', 'shell', 'body')),
  trigger_index integer NOT NULL CHECK (trigger_index >= 0 AND (role = 'shell' OR trigger_index = 0)),
  workflow_id uuid NOT NULL REFERENCES public.workflows (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipedream_hashid, role, trigger_index)
);

CREATE INDEX pipedream_workflow_map_workflow_id_idx ON porting.pipedream_workflow_map (workflow_id);

COMMENT ON TABLE porting.pipedream_workflow_map IS
  'Which Bidspoke workflow stands for which Pipedream workflow (#1710, plan 0.2). One whole row for a plain workflow; one body row and one shell row per trigger for a split one. Look up an exact (pipedream_hashid, role, trigger_index) and refuse on more than one match (L521).';

ALTER TABLE porting.pipedream_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE porting.pipedream_workflow_map ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON porting.pipedream_inventory, porting.pipedream_workflow_map FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON porting.pipedream_inventory, porting.pipedream_workflow_map TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA porting REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA porting REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA porting REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, porting';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
