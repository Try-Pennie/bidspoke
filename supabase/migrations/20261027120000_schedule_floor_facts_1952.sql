-- The facts a ported schedule's floor is taken from (#1952, #1698 D8), kept in
-- the porting schema beside the inventory and the workflow map (#1710).
--
-- WHY. The ops tick never fires a slot at or before a schedule's floor. For a
-- workflow ported from Pipedream the floor must include the instant Pipedream's
-- copy was paused at cutover, or catch up re-fires a period Pipedream already
-- ran; and a workflow minted under a new id (a converter rerun, a split) must
-- not re-fire a slot the id it replaces already served. Neither fact was
-- recorded anywhere, so the floor was only when the ops database first held
-- the schedule.
--
-- WHAT.
--   porting.pipedream_inventory.cut_over_at  when the Pipedream workflow was
--     paused at its cutover (#1697, plan 11.3). One home for it (L83): a
--     Pipedream workflow is paused whole, so a split workflow's shells and body
--     share it, read through the map. Only a workflow at porting_stage cut_over
--     or settled may carry one. Null while it is not cut over, and the ops tick
--     then fires none of the schedules of a Bidspoke workflow mapped to it,
--     since Pipedream may still run every period.
--   porting.workflow_replacements  one row per replacement: workflow_id stands
--     in for replaces_workflow_id. Its own table rather than a column of the
--     map, because the map keeps one row per (hashid, role, trigger index) and
--     is re-pointed when a new id takes over, which would lose the id before
--     the last (a second converter rerun). Recorded once and never rewritten:
--     corrected by a delete and a new row. Both workflows belong to one
--     organization, held by a trigger, so one organization's floor is never
--     lifted from another's runs.
--
-- WHO WRITES THEM. Nothing yet: the cutover (#1697) and the converter will.
-- The bidding Worker's OpsGateway serves both to the ops tick with each ops
-- workflow (lib/ops-gateway.ts readOpsWorkflows).
--
-- Additive only (ADR 0007): a nullable column, a CHECK every existing row
-- meets (a new column is null), and a new table. The inventory loader writes
-- named columns (packages/porting-evidence INVENTORY_COLUMNS), so it never
-- touches cut_over_at.
-- Guarded by supabase/tests/schedule_floor_facts.test.sql.

SET LOCAL lock_timeout = '5s';

ALTER TABLE porting.pipedream_inventory ADD COLUMN cut_over_at timestamptz;
ALTER TABLE porting.pipedream_inventory ADD CONSTRAINT pipedream_inventory_cut_over_at_stage
  CHECK (cut_over_at IS NULL OR porting_stage IN ('cut_over', 'settled'));

COMMENT ON COLUMN porting.pipedream_inventory.cut_over_at IS
  'When Pipedream''s copy was paused at cutover (#1697, #1952). The floor of every schedule of a Bidspoke workflow mapped to this one: no slot at or before it fires. Null while not cut over, and such a schedule fires nothing.';

CREATE TABLE porting.workflow_replacements (
  workflow_id           uuid NOT NULL REFERENCES public.workflows (id),
  replaces_workflow_id  uuid NOT NULL REFERENCES public.workflows (id),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, replaces_workflow_id),
  CONSTRAINT workflow_replacements_not_itself CHECK (workflow_id <> replaces_workflow_id)
);

CREATE INDEX workflow_replacements_replaces_idx ON porting.workflow_replacements (replaces_workflow_id);

COMMENT ON TABLE porting.workflow_replacements IS
  'Which Bidspoke workflow replaces which (#1952, #1698 1.6): the new one''s schedules never fire a slot the one it replaces, or any that one replaced, already served. Recorded once, never rewritten; both workflows in one organization.';

-- Both workflows in one organization. A trigger, because a CHECK cannot read
-- another table; workflows never change organization, so checking the new row
-- is enough.
CREATE FUNCTION porting.workflow_replacements_same_organization()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $fn$
DECLARE
  v_orgs integer;
BEGIN
  SELECT count(DISTINCT w.organization_id) INTO v_orgs
  FROM public.workflows w WHERE w.id IN (NEW.workflow_id, NEW.replaces_workflow_id);
  IF v_orgs > 1 THEN
    RAISE EXCEPTION 'workflow % cannot replace workflow %: they belong to different organizations', NEW.workflow_id, NEW.replaces_workflow_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER workflow_replacements_same_organization
  BEFORE INSERT ON porting.workflow_replacements
  FOR EACH ROW EXECUTE FUNCTION porting.workflow_replacements_same_organization();

REVOKE ALL ON FUNCTION porting.workflow_replacements_same_organization() FROM PUBLIC, anon, authenticated;

ALTER TABLE porting.workflow_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON porting.workflow_replacements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON porting.workflow_replacements TO service_role;
