-- A Pipedream workflow that will not be ported, and a step left out of a port
-- (#2979), recorded in the porting schema beside the inventory (#1710).
--
-- WHY. The #2671 investigation found workflows whose only Assistants API calls
-- sit behind an End Workflow, or that are switched on with no sign of running.
-- The inventory had nowhere to say "this will not be ported" or "port it without
-- this step", so the only way such a decision left the port list was switching
-- the workflow off in Pipedream before the next export.
--
-- WHAT.
--   porting_stage gains 'retired', with retired_by, retired_reason and
--     retired_at: who decided, why and when. All three are set exactly when
--     the stage is retired (a CHECK), so a retirement never stands without
--     its reason and a stale reason never outlives one.
--   porting.dropped_steps  one row per step left out of a port: the workflow,
--     the step's namespace, who decided, why and when. Its own table, so the
--     loader's upsert of the inventory can never touch it. Recorded once,
--     never rewritten: corrected by a delete and a new row.
--
-- WHO WRITES THEM. Only a person, through scripts/porting/record-decision.ts,
-- which prints its plan and writes nothing without --apply. The loader
-- (scripts/porting/load-inventory.ts) writes named export columns only
-- (packages/porting-evidence INVENTORY_COLUMNS), so a reload of a newer export
-- keeps every decision. The unlock table leaves retired workflows and dropped
-- steps out.
--
-- Additive only (ADR 0007): the stage CHECK is widened (every stored value is
-- still allowed and nothing deployed writes the new one), three nullable
-- columns and a CHECK every existing row meets (none is retired and the new
-- columns are null), and a new table. Service role only, like the rest of the
-- schema: RLS on with no policy, anon and authenticated revoked by name.
-- Guarded by supabase/tests/porting_inventory.test.sql.

SET LOCAL lock_timeout = '5s';

-- The CHECK the first porting migration declared inline, under Postgres's name
-- for it. IF EXISTS as every drop here is; were the name ever different, the old
-- CHECK would still refuse 'retired', which the SQL suite's retire case catches.
ALTER TABLE porting.pipedream_inventory DROP CONSTRAINT IF EXISTS pipedream_inventory_porting_stage_check;
ALTER TABLE porting.pipedream_inventory ADD CONSTRAINT pipedream_inventory_porting_stage_check
  CHECK (porting_stage IN ('none', 'drafted', 'cut_over', 'settled', 'retired'));

ALTER TABLE porting.pipedream_inventory ADD COLUMN retired_by text;
ALTER TABLE porting.pipedream_inventory ADD COLUMN retired_reason text;
ALTER TABLE porting.pipedream_inventory ADD COLUMN retired_at timestamptz;
ALTER TABLE porting.pipedream_inventory ADD CONSTRAINT pipedream_inventory_retired_decision CHECK (
  CASE WHEN porting_stage = 'retired'
    THEN retired_by IS NOT NULL AND btrim(retired_by) <> ''
     AND retired_reason IS NOT NULL AND btrim(retired_reason) <> ''
     AND retired_at IS NOT NULL
    ELSE retired_by IS NULL AND retired_reason IS NULL AND retired_at IS NULL
  END
);

COMMENT ON COLUMN porting.pipedream_inventory.retired_by IS
  'Who decided this workflow will not be ported (#2979). Set exactly when porting_stage is retired, with retired_reason and retired_at. Written only by scripts/porting/record-decision.ts, never by the loader.';
COMMENT ON COLUMN porting.pipedream_inventory.retired_reason IS
  'Why this workflow will not be ported (#2979). Set exactly when porting_stage is retired.';
COMMENT ON COLUMN porting.pipedream_inventory.retired_at IS
  'When the retirement was recorded (#2979). Set exactly when porting_stage is retired.';

CREATE TABLE porting.dropped_steps (
  pipedream_hashid text NOT NULL REFERENCES porting.pipedream_inventory (pipedream_hashid),
  step text NOT NULL CHECK (step ~ '^\S+$'),
  dropped_by text NOT NULL CHECK (btrim(dropped_by) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  dropped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipedream_hashid, step)
);

COMMENT ON TABLE porting.dropped_steps IS
  'Steps of a Pipedream workflow left out of its port (#2979): step is the step''s namespace in the export, with who decided, why and when. Recorded once by scripts/porting/record-decision.ts, never rewritten (corrected by a delete and a new row), never touched by the loader. The unlock table leaves these steps out of what a workflow needs.';

ALTER TABLE porting.dropped_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON porting.dropped_steps FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON porting.dropped_steps TO service_role;

NOTIFY pgrst, 'reload schema';
