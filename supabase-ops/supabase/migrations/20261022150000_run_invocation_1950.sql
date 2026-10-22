-- B3 of the #1698 run engine (#1950), PR 3 of its split: how long the tick's
-- observations are kept, and a copy of each workflow version's definition.
--
-- 1. schedule_fire_observations is kept 30 days (Dan, 2026-10-22, on #1950).
--    purge_schedule_observations deletes, a page at a time, rows observed more
--    than 30 days before the database's now: the window lives here, so no
--    caller can purge sooner. It never deletes a workflow's LATEST row, whatever
--    its age, because workflow_copies reads the last observed slot from it, and
--    a schedule that fires less often than monthly would otherwise be planned
--    as if it had never fired (L5). The tick runs it once a night as the
--    observation_purge sweep, which claim_ops_sweep gains here.
-- 2. ops_workflow_definitions holds each workflow version's definition as the
--    bidding Worker served it (decision 4 on #1949: the bidding database stays
--    the one home of every definition, and this is a copy). A saved version
--    never changes, so the copy never goes stale, and a run executes its
--    recorded version through a bidding outage. save_workflow_definition
--    answers saved or already_saved; it refuses a different definition for a
--    version it holds (conflict: the bidding side broke its own rule, which the
--    tick pages on), and a workflow with no saved copy or whose copy is another
--    organization's. workflow_definition reads one version of one
--    organization's workflow; missing_workflow_definitions lists the saved
--    copies whose current version has no definition yet, which is what the
--    tick asks the bidding Worker for.
--
-- Additive only (ADR 0007): a new table, an index, four new functions, and the
-- sweep list widened by one name. Guarded by
-- supabase-ops/supabase/tests/run_invocation.test.sql.

SET lock_timeout = '10s';

-- ── observation_purge joins the sweeps ───────────────────────────────────────
-- Every live row is one of the six names, so validating the wider CHECK reads them.
ALTER TABLE public.ops_lane_sweeps DROP CONSTRAINT ops_lane_sweeps_sweep_check;
ALTER TABLE public.ops_lane_sweeps ADD CONSTRAINT ops_lane_sweeps_sweep_check CHECK (sweep IN
  ('lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits', 'observation_purge'));

-- As in 20261017220000_ops_connections_2334.sql, with observation_purge on its list.
CREATE OR REPLACE FUNCTION public.claim_ops_sweep(p_sweep text, p_owner text, p_every_seconds integer)
RETURNS TABLE (owned boolean, db_now timestamptz, last_started_at timestamptz, last_owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_row record;
BEGIN
  IF p_sweep IS NULL OR p_sweep NOT IN ('lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits', 'observation_purge') THEN
    RAISE EXCEPTION 'claim_ops_sweep: % is not a sweep', p_sweep USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'claim_ops_sweep: an owner of 1 to 200 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_every_seconds IS NULL OR p_every_seconds NOT BETWEEN 10 AND 86400 THEN
    RAISE EXCEPTION 'claim_ops_sweep: every must be 10 to 86400 seconds, not %', p_every_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('ops_sweep:' || p_sweep, 0)) THEN
    SELECT s.last_started_at, s.last_owner INTO v_row FROM public.ops_lane_sweeps s WHERE s.sweep = p_sweep;
    RETURN QUERY SELECT false, v_now, v_row.last_started_at, v_row.last_owner;
    RETURN;
  END IF;

  INSERT INTO public.ops_lane_sweeps (sweep) VALUES (p_sweep) ON CONFLICT (sweep) DO NOTHING;
  UPDATE public.ops_lane_sweeps s SET last_started_at = v_now, last_owner = p_owner
  WHERE s.sweep = p_sweep AND (s.last_started_at IS NULL OR s.last_started_at <= v_now - make_interval(secs => p_every_seconds))
  RETURNING s.last_started_at, s.last_owner INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_now, v_row.last_started_at, v_row.last_owner;
    RETURN;
  END IF;
  SELECT s.last_started_at, s.last_owner INTO v_row FROM public.ops_lane_sweeps s WHERE s.sweep = p_sweep;
  RETURN QUERY SELECT false, v_now, v_row.last_started_at, v_row.last_owner;
END
$fn$;

-- ── purge_schedule_observations ──────────────────────────────────────────────
-- The purge reads by age, oldest first.
CREATE INDEX schedule_fire_observations_age_idx ON public.schedule_fire_observations (observed_at, id);

-- Deletes up to p_limit observations older than 30 days, oldest first, except
-- each workflow's latest slot (checked over the UNIQUE (workflow_id,
-- scheduled_for) index). Rows another session holds are skipped, not waited
-- on. more says a full page went, so call again. Lane wide: retention is the
-- same for every organization.
CREATE FUNCTION public.purge_schedule_observations(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '30 days';
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_schedule_observations: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT o.id FROM public.schedule_fire_observations o
    WHERE o.observed_at < v_cutoff
      AND EXISTS (SELECT 1 FROM public.schedule_fire_observations n WHERE n.workflow_id = o.workflow_id AND n.scheduled_for > o.scheduled_for)
    ORDER BY o.observed_at, o.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.schedule_fire_observations o USING old WHERE o.id = old.id RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM gone;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── ops_workflow_definitions ─────────────────────────────────────────────────
CREATE TABLE public.ops_workflow_definitions (
  workflow_id      uuid NOT NULL,
  version_number   integer NOT NULL CONSTRAINT ops_workflow_definitions_version_check CHECK (version_number >= 1),
  organization_id  uuid NOT NULL,
  definition       jsonb NOT NULL CONSTRAINT ops_workflow_definitions_definition_check CHECK (jsonb_typeof(definition) = 'object'),
  saved_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_workflow_definitions_pkey PRIMARY KEY (workflow_id, version_number),
  -- A definition is a graph of nodes, not a data store: 4 MB is far past any we hold.
  CONSTRAINT ops_workflow_definitions_size CHECK (octet_length(definition::text) <= 4194304)
);
ALTER TABLE public.ops_workflow_definitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_workflow_definitions FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.ops_workflow_definitions FROM service_role;
GRANT SELECT ON public.ops_workflow_definitions TO service_role;

-- One version's definition, as served. Answers saved, already_saved (the same
-- definition is held), conflict (a different one is held, and is kept), or
-- no_copy (no saved copy of this workflow: the copies are saved first, and they
-- are what places a workflow in an organization). A workflow whose copy is
-- another organization's is refused (insufficient_privilege), as
-- record_schedule_observation refuses one.
CREATE FUNCTION public.save_workflow_definition(
  p_organization_id  uuid,
  p_workflow_id      uuid,
  p_version_number   integer,
  p_definition       jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_held jsonb;
  v_copy_org uuid;
BEGIN
  IF p_version_number IS NULL OR p_version_number < 1 THEN
    RAISE EXCEPTION 'save_workflow_definition: a version of 1 or more is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_definition IS NULL OR jsonb_typeof(p_definition) <> 'object' THEN
    RAISE EXCEPTION 'save_workflow_definition: a definition is a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.organization_id INTO v_copy_org FROM public.ops_workflow_copies c WHERE c.workflow_id = p_workflow_id;
  IF NOT FOUND THEN
    RETURN 'no_copy';
  END IF;
  IF v_copy_org <> p_organization_id THEN
    RAISE EXCEPTION 'save_workflow_definition: workflow % is not this organization''s', p_workflow_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ops_workflow_definitions (workflow_id, version_number, organization_id, definition)
  VALUES (p_workflow_id, p_version_number, p_organization_id, p_definition)
  ON CONFLICT ON CONSTRAINT ops_workflow_definitions_pkey DO NOTHING;
  IF FOUND THEN
    RETURN 'saved';
  END IF;
  SELECT d.definition INTO v_held FROM public.ops_workflow_definitions d
  WHERE d.workflow_id = p_workflow_id AND d.version_number = p_version_number AND d.organization_id = p_organization_id;
  IF NOT FOUND THEN
    -- Held under another organization, against what the copy says: refused, never answered.
    RAISE EXCEPTION 'save_workflow_definition: workflow % version % is held for another organization', p_workflow_id, p_version_number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN v_held = p_definition THEN 'already_saved' ELSE 'conflict' END;
END
$fn$;

-- One version of one organization's workflow; no row when it is not held.
CREATE FUNCTION public.workflow_definition(p_organization_id uuid, p_workflow_id uuid, p_version_number integer)
RETURNS TABLE (definition jsonb, saved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT d.definition, d.saved_at FROM public.ops_workflow_definitions d
  WHERE d.organization_id = p_organization_id AND d.workflow_id = p_workflow_id AND d.version_number = p_version_number;
$fn$;

-- The saved copies whose current version has no definition held, in workflow
-- order, at most p_limit. Lane wide: each row carries its organization.
CREATE FUNCTION public.missing_workflow_definitions(p_limit integer)
RETURNS TABLE (workflow_id uuid, organization_id uuid, version_number integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'missing_workflow_definitions: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.workflow_id, c.organization_id, c.version_number FROM public.ops_workflow_copies c
  WHERE c.version_number IS NOT NULL AND c.deleted_at IS NULL AND c.withdrawn_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.ops_workflow_definitions d WHERE d.workflow_id = c.workflow_id AND d.version_number = c.version_number)
  ORDER BY c.workflow_id
  LIMIT p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'claim_ops_sweep', 'purge_schedule_observations', 'save_workflow_definition', 'workflow_definition', 'missing_workflow_definitions')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
