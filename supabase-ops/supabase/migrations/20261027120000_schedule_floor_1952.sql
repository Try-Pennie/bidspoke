-- A ported schedule's floor (#1952, #1698 D8), kept with the ops workflow copy.
--
-- WHY. The tick never fires a slot at or before a schedule's floor. Until now
-- that floor was only schedule_known_since, when this database first held the
-- schedule, so a workflow ported from Pipedream could catch up a period
-- Pipedream already ran, and a workflow minted under a new id could re-fire a
-- slot the id it replaces already served. The bidding Worker now serves, with
-- each ops workflow, the porting facts from its porting schema
-- (supabase/migrations/20261027120000_schedule_floor_facts_1952.sql): whether
-- it stands for a Pipedream workflow, when that one was cut over, and every
-- workflow it replaces. They are kept here with the last good copy, so a
-- bidding outage plans from the facts last served (decision 4).
--
-- WHAT.
--   ops_workflow_copies gains four columns, all null until a list carries the
--   facts (a copy saved by an ops release before #1952), which the tick reads
--   as unknown and fires nothing from:
--     ported             the workflow stands for a Pipedream workflow
--     cutover_at         when that Pipedream workflow was paused at cutover;
--                        null for a ported one not cut over yet, and the tick
--                        then fires nothing, since Pipedream may run any period
--     replaces           every workflow it replaces, directly or not (at most 50)
--     porting_served_at  the served_at of the list the facts came from
--   save_workflow_copies saves them under their own order rule: a list's facts
--   replace the stored ones when it was served no earlier than the list they
--   came from, whatever the workflow row's own order says, because a cutover or
--   a replacement is recorded without the workflow row changing. A save that
--   carries no facts leaves them. Malformed facts are refused by name.
--   workflow_copies answers them, and replaced_last_slot: the latest slot fired
--   (schedule_fires) or observed (schedule_fire_observations) by any workflow
--   the copy replaces, within the copy's organization. Observed counts too,
--   since a higher floor only drops a catch up, never doubles a run.
--
-- Additive (ADR 0007): nullable columns, a CHECK every existing row meets (all
-- four null), save_workflow_copies with the same signature and the old copy
-- shape still accepted, and workflow_copies with columns added after the old
-- ones, which an ops release before #1952 reads past. workflow_copies is
-- dropped and created again in this one transaction, since its return type
-- changes, and its grants are set again here.
-- Guarded by supabase-ops/supabase/tests/schedule_floor.test.sql.

ALTER TABLE public.ops_workflow_copies
  ADD COLUMN ported boolean,
  ADD COLUMN cutover_at timestamptz,
  ADD COLUMN replaces uuid[],
  ADD COLUMN porting_served_at timestamptz,
  ADD CONSTRAINT ops_workflow_copies_porting_told CHECK (
    (porting_served_at IS NULL) = (ported IS NULL) AND (ported IS NULL) = (replaces IS NULL)),
  ADD CONSTRAINT ops_workflow_copies_cutover_ported CHECK (cutover_at IS NULL OR ported),
  ADD CONSTRAINT ops_workflow_copies_replaces_size CHECK (replaces IS NULL OR cardinality(replaces) <= 50);

-- ── save_workflow_copies ──────────────────────────────────────────────────────
-- As in 20261017090000_ops_tick_1949.sql, plus each copy's optional porting
-- facts: {ported, cutover_at, replaces}.
CREATE OR REPLACE FUNCTION public.save_workflow_copies(p_served_at timestamptz, p_complete boolean, p_copies jsonb)
RETURNS TABLE (inserted integer, updated integer, confirmed integer, refused_older integer, withdrawn integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_copy record;
  v_old public.ops_workflow_copies%ROWTYPE;
  v_timing text;
  v_off boolean;
  v_new_row boolean;
  v_ported boolean;
  v_cutover timestamptz;
  v_replaces uuid[];
  v_inserted integer := 0;
  v_updated integer := 0;
  v_confirmed integer := 0;
  v_older integer := 0;
  v_withdrawn integer := 0;
  v_ids uuid[];
BEGIN
  IF p_served_at IS NULL OR p_complete IS NULL THEN
    RAISE EXCEPTION 'save_workflow_copies: served_at and complete are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_copies IS NULL OR jsonb_typeof(p_copies) <> 'array' THEN
    RAISE EXCEPTION 'save_workflow_copies: the copies must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_copies) > 1000 THEN
    RAISE EXCEPTION 'save_workflow_copies: at most 1000 copies in one call, not %', jsonb_array_length(p_copies) USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_copy IN
    SELECT (e->>'workflow_id')::uuid AS workflow_id, (e->>'organization_id')::uuid AS organization_id,
      (e->>'is_active')::boolean AS is_active, (e->>'deleted_at')::timestamptz AS deleted_at,
      (e->>'row_updated_at')::timestamptz AS row_updated_at, (e->>'version_number')::integer AS version_number,
      CASE WHEN jsonb_typeof(e->'trigger') = 'object' THEN e->'trigger' END AS trigger,
      e ? 'porting' AS has_porting, e->'porting' AS porting
    FROM jsonb_array_elements(p_copies) e
    ORDER BY (e->>'workflow_id')::uuid
  LOOP
    IF v_copy.workflow_id IS NULL OR v_copy.organization_id IS NULL OR v_copy.is_active IS NULL OR v_copy.row_updated_at IS NULL THEN
      RAISE EXCEPTION 'save_workflow_copies: a copy needs its workflow, organization, on or off state and row_updated_at' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The porting facts, read before anything is written, so malformed ones save nothing.
    IF v_copy.has_porting THEN
      IF jsonb_typeof(v_copy.porting) IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_copy.porting->'ported') IS DISTINCT FROM 'boolean'
        OR coalesce(jsonb_typeof(v_copy.porting->'cutover_at'), 'missing') NOT IN ('null', 'string')
        OR jsonb_typeof(v_copy.porting->'replaces') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'save_workflow_copies: the porting facts of workflow % are not {ported, cutover_at, replaces}', v_copy.workflow_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_ported := (v_copy.porting->>'ported')::boolean;
      v_cutover := (v_copy.porting->>'cutover_at')::timestamptz;
      SELECT coalesce(array_agg(r::uuid ORDER BY r::uuid), ARRAY[]::uuid[]) INTO v_replaces FROM jsonb_array_elements_text(v_copy.porting->'replaces') r;
      IF v_cutover IS NOT NULL AND NOT v_ported THEN
        RAISE EXCEPTION 'save_workflow_copies: workflow % has a cutover time but stands for no Pipedream workflow', v_copy.workflow_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_copy.workflow_id = ANY (v_replaces) THEN
        RAISE EXCEPTION 'save_workflow_copies: workflow % is listed as replacing itself', v_copy.workflow_id USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF cardinality(v_replaces) > 50 THEN
        RAISE EXCEPTION 'save_workflow_copies: workflow % replaces % workflows, more than 50', v_copy.workflow_id, cardinality(v_replaces)
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;

    v_ids := v_ids || v_copy.workflow_id;
    v_timing := CASE WHEN v_copy.trigger->>'type' = 'schedule' THEN
      concat_ws('|', coalesce(v_copy.trigger->'config'->>'cron', ''), coalesce(v_copy.trigger->'config'->>'interval_seconds', ''),
        coalesce(v_copy.trigger->'config'->>'timezone', '')) END;
    v_off := NOT v_copy.is_active OR v_copy.deleted_at IS NOT NULL;
    v_new_row := false;

    SELECT * INTO v_old FROM public.ops_workflow_copies c WHERE c.workflow_id = v_copy.workflow_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, deleted_at, row_updated_at, version_number, trigger,
        schedule_timing, schedule_known_since, switched_off_at, served_at, received_at, confirmed_at)
      VALUES (v_copy.workflow_id, v_copy.organization_id, v_copy.is_active, v_copy.deleted_at, v_copy.row_updated_at, v_copy.version_number,
        v_copy.trigger, v_timing, CASE WHEN v_timing IS NOT NULL THEN v_now END, CASE WHEN v_off THEN v_copy.row_updated_at END,
        p_served_at, v_now, v_now)
      ON CONFLICT (workflow_id) DO NOTHING;
      IF FOUND THEN
        v_inserted := v_inserted + 1;
        v_new_row := true;
      ELSE
        -- Another save inserted it between the read and the insert: take it as it now is.
        SELECT * INTO v_old FROM public.ops_workflow_copies c WHERE c.workflow_id = v_copy.workflow_id FOR UPDATE;
      END IF;
    END IF;

    IF NOT v_new_row THEN
      IF v_old.organization_id <> v_copy.organization_id THEN
        RAISE EXCEPTION 'save_workflow_copies: workflow % belongs to another organization', v_copy.workflow_id USING ERRCODE = 'insufficient_privilege';
      END IF;

      IF v_copy.row_updated_at > v_old.row_updated_at THEN
        UPDATE public.ops_workflow_copies c
        SET is_active = v_copy.is_active, deleted_at = v_copy.deleted_at, row_updated_at = v_copy.row_updated_at,
            version_number = v_copy.version_number, trigger = v_copy.trigger, schedule_timing = v_timing,
            schedule_known_since = CASE WHEN v_timing IS NULL THEN NULL
                                        WHEN v_timing IS NOT DISTINCT FROM v_old.schedule_timing THEN v_old.schedule_known_since
                                        ELSE v_now END,
            switched_off_at = CASE WHEN v_off THEN greatest(v_old.switched_off_at, v_copy.row_updated_at) ELSE v_old.switched_off_at END,
            withdrawn_at = CASE WHEN v_old.withdrawn_at IS NOT NULL AND p_served_at <= v_old.withdrawn_at THEN v_old.withdrawn_at END,
            served_at = greatest(v_old.served_at, p_served_at), received_at = v_now, confirmed_at = v_now
        WHERE c.workflow_id = v_copy.workflow_id;
        v_updated := v_updated + 1;
      ELSIF v_copy.row_updated_at = v_old.row_updated_at THEN
        UPDATE public.ops_workflow_copies c
        SET withdrawn_at = CASE WHEN v_old.withdrawn_at IS NOT NULL AND p_served_at <= v_old.withdrawn_at THEN v_old.withdrawn_at END,
            served_at = greatest(v_old.served_at, p_served_at), confirmed_at = v_now
        WHERE c.workflow_id = v_copy.workflow_id;
        v_confirmed := v_confirmed + 1;
      ELSE
        v_older := v_older + 1;
      END IF;
    END IF;

    -- The porting facts keep their own order: by when the list was served, so a
    -- cutover recorded without the workflow row changing still arrives, and an
    -- older list read before it cannot take it away.
    IF v_copy.has_porting THEN
      UPDATE public.ops_workflow_copies c
      SET ported = v_ported, cutover_at = v_cutover, replaces = v_replaces, porting_served_at = p_served_at
      WHERE c.workflow_id = v_copy.workflow_id AND (c.porting_served_at IS NULL OR c.porting_served_at <= p_served_at);
    END IF;
  END LOOP;

  IF p_complete THEN
    -- A complete list newer than the one that last named a workflow, and that
    -- does not name it, withdraws it. Bounded: the copies are the ops workflows.
    WITH gone AS (
      SELECT c.workflow_id FROM public.ops_workflow_copies c
      WHERE c.withdrawn_at IS NULL AND c.served_at < p_served_at AND c.workflow_id <> ALL (coalesce(v_ids, ARRAY[]::uuid[]))
      ORDER BY c.workflow_id
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE public.ops_workflow_copies c SET withdrawn_at = p_served_at
    FROM gone WHERE c.workflow_id = gone.workflow_id;
    GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_inserted, v_updated, v_confirmed, v_older, v_withdrawn;
END
$fn$;

-- ── workflow_copies ───────────────────────────────────────────────────────────
-- As in 20261017090000_ops_tick_1949.sql, plus the porting facts and the last
-- slot of the workflows the copy replaces, each read over the UNIQUE
-- (workflow_id, scheduled_for) indexes.
DROP FUNCTION public.workflow_copies(integer);
CREATE FUNCTION public.workflow_copies(p_limit integer)
RETURNS TABLE (
  workflow_id uuid, organization_id uuid, is_active boolean, deleted_at timestamptz, withdrawn_at timestamptz,
  row_updated_at timestamptz, version_number integer, trigger jsonb, schedule_known_since timestamptz,
  switched_off_at timestamptz, served_at timestamptz, received_at timestamptz, confirmed_at timestamptz,
  may_start boolean, last_served timestamptz, last_observed timestamptz, db_now timestamptz,
  ported boolean, cutover_at timestamptz, replaces uuid[], porting_served_at timestamptz, replaced_last_slot timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'workflow_copies: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.workflow_id, c.organization_id, c.is_active, c.deleted_at, c.withdrawn_at, c.row_updated_at, c.version_number, c.trigger,
    c.schedule_known_since, c.switched_off_at, c.served_at, c.received_at, c.confirmed_at,
    -- The one rule a run starts by: on, not deleted, not withdrawn, and newer than
    -- the last known switch off.
    (c.is_active AND c.deleted_at IS NULL AND c.withdrawn_at IS NULL
      AND (c.switched_off_at IS NULL OR c.row_updated_at > c.switched_off_at)),
    (SELECT max(f.scheduled_for) FROM public.schedule_fires f WHERE f.workflow_id = c.workflow_id),
    (SELECT max(o.scheduled_for) FROM public.schedule_fire_observations o WHERE o.workflow_id = c.workflow_id),
    now(),
    c.ported, c.cutover_at, c.replaces, c.porting_served_at,
    (SELECT max(s.slot) FROM unnest(c.replaces) AS r(id),
      LATERAL (
        SELECT max(f.scheduled_for) AS slot FROM public.schedule_fires f WHERE f.workflow_id = r.id AND f.organization_id = c.organization_id
        UNION ALL
        SELECT max(o.scheduled_for) FROM public.schedule_fire_observations o WHERE o.workflow_id = r.id AND o.organization_id = c.organization_id
      ) s)
  FROM public.ops_workflow_copies c
  ORDER BY c.workflow_id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.workflow_copies(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_copies(integer) TO service_role;
