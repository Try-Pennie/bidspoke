-- The ops minute cron's state (#1949, track B2 of the #1698 run engine, plan:
-- discussion #1945). Three tables and six functions in the ops project, beside
-- the run engine's (#1948, 20261016200000_run_engine_1948.sql).
--
-- WHAT.
--   ops_workflow_copies  the last copy of each ops workflow's state the bidding
--                  Worker served (Dan's decision 4, 2026-10-16, on #1949): on or
--                  off, deleted, its latest version and its trigger. A COPY of
--                  what the bidding database holds, never written by a person
--                  and never edited here; the bidding database stays the one
--                  home of every definition. It is what lets ported workflows
--                  keep their schedules through a bidding database outage.
--   schedule_fire_observations  what the tick WOULD have fired, one row per
--                  schedule slot, while it runs in observe mode (#1949: it
--                  computes and records what it would run, and runs nothing).
--                  Apart from schedule_fires on purpose: a slot observed here
--                  is not a slot served, so switching to live mode later fires
--                  from schedule_fires and is not misled by what was observed.
--   ops_lane_sweeps  one row per maintenance sweep the tick runs, the timestamp
--                  each one's interval is claimed by (#1698 1.4, from pg-boss
--                  trySetTimestamp), so overlapping and retried ticks never run
--                  one sweep twice at once.
--
-- THE COPY'S RULES (decision 4: "a run must not start from a copy older than the
-- last known switch-off").
-- * Order. A copy replaces the stored one only when its row_updated_at (the
--   bidding row's updated_at, which a trigger moves on every update: a save, a
--   switch off, a delete) is newer. An older one is refused and counted, so two
--   overlapping ticks whose fetches straddle a switch off cannot put the
--   workflow back on, whichever saves last. An equal one only confirms.
-- * switched_off_at is the newest row_updated_at of any copy that said off or
--   deleted, and it never moves back. may_start (in workflow_copies) is false
--   for a copy that is not newer than it, whatever else the copy says. The tick
--   plans from what workflow_copies returns AFTER its save, never from its own
--   fetch, which may be the older of two.
-- * Withdrawal. A complete list that no longer names a workflow (moved out of
--   the ops lane, or hard deleted) withdraws it, as of that list's served_at,
--   and only a list served later can bring it back.
-- * The floor (#1698 D8). schedule_known_since is when this database first held
--   the schedule's current timing (cron or interval, and zone). It is reset when
--   the timing changes and cleared when the trigger stops being a schedule, so
--   no slot from before the schedule existed in this form is ever fired or
--   caught up.
--
-- ORGANIZATION. Every table carries organization_id uuid NOT NULL (the live
-- privilege check refuses one that does not). A copy and an observation belong
-- to their workflow's organization, and every function that writes one matches
-- the organization it is given against the stored row. ops_lane_sweeps holds the
-- lane's own system state, which belongs to no organization, so its rows carry
-- the nil uuid, held there by a CHECK so it can never be read as one.
--
-- Additive only (ADR 0007): new tables and functions, nothing existing changes.
-- Guarded by supabase-ops/supabase/tests/ops_tick.test.sql.

-- ── ops_workflow_copies ───────────────────────────────────────────────────────
CREATE TABLE public.ops_workflow_copies (
  workflow_id           uuid PRIMARY KEY,
  organization_id       uuid NOT NULL,
  is_active             boolean NOT NULL,
  deleted_at            timestamptz,
  row_updated_at        timestamptz NOT NULL,
  version_number        integer,
  trigger               jsonb,
  -- The schedule's timing as one text (cron or interval, and zone), null when the
  -- trigger is not a schedule. Computed here, so the floor rule has one home.
  schedule_timing       text,
  schedule_known_since  timestamptz,
  switched_off_at       timestamptz,
  -- The served_at of the complete list that stopped naming this workflow.
  withdrawn_at          timestamptz,
  -- The bidding Worker's clock when it served the newest list that named this row.
  served_at             timestamptz NOT NULL,
  -- When this database first held the copy at this row_updated_at.
  received_at           timestamptz NOT NULL DEFAULT now(),
  -- When a served list last named it unchanged, or changed.
  confirmed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_workflow_copies_version_check CHECK (version_number IS NULL OR version_number >= 1),
  CONSTRAINT ops_workflow_copies_floor_check CHECK ((schedule_timing IS NULL) = (schedule_known_since IS NULL)),
  CONSTRAINT ops_workflow_copies_trigger_size CHECK (trigger IS NULL OR octet_length(trigger::text) <= 65536)
);

-- ── schedule_fire_observations ────────────────────────────────────────────────
CREATE TABLE public.schedule_fire_observations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  workflow_id             uuid NOT NULL,
  workflow_version        integer NOT NULL CHECK (workflow_version >= 1),
  scheduled_for           timestamptz NOT NULL,
  -- The vocabularies. Their one TypeScript home is apps/worker/src/ops/run-vocabulary.ts,
  -- and apps/web/src/lib/__tests__/ops-run-vocabulary-matches-db.test.ts fails when the two differ.
  outcome                 text NOT NULL CONSTRAINT schedule_fire_observations_outcome_check CHECK (outcome IN ('would_fire', 'missed')),
  reason                  text NOT NULL CONSTRAINT schedule_fire_observations_reason_check CHECK (reason IN
    ('due', 'catch_up', 'catch_up_none', 'outside_catch_up_window', 'superseded_by_due_fire')),
  -- A fire is dispatched at its slot plus the workflow's fixed jitter (#1698 D7); a miss has none.
  dispatch_at             timestamptz,
  previous_scheduled_for  timestamptz,
  tick_id                 text NOT NULL CHECK (length(tick_id) BETWEEN 1 AND 200),
  observed_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_fire_observations_slot_key UNIQUE (workflow_id, scheduled_for),
  CONSTRAINT schedule_fire_observations_pair_check CHECK (
    (outcome = 'would_fire' AND reason IN ('due', 'catch_up') AND dispatch_at IS NOT NULL)
    OR (outcome = 'missed' AND reason IN ('catch_up_none', 'outside_catch_up_window', 'superseded_by_due_fire') AND dispatch_at IS NULL))
);

-- ── ops_lane_sweeps ───────────────────────────────────────────────────────────
CREATE TABLE public.ops_lane_sweeps (
  sweep            text PRIMARY KEY CONSTRAINT ops_lane_sweeps_sweep_check CHECK (sweep IN ('lease_expiry', 'run_expiry', 'queue_agreement')),
  -- The lane's own row, never an organization's (see ORGANIZATION above).
  organization_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT ops_lane_sweeps_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  last_started_at  timestamptz,
  last_owner       text
);

-- ── privileges: the choke point, as for the run engine's tables ──────────────
ALTER TABLE public.ops_workflow_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_fire_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_lane_sweeps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_workflow_copies, public.schedule_fire_observations, public.ops_lane_sweeps FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.ops_workflow_copies, public.schedule_fire_observations, public.ops_lane_sweeps FROM service_role;
GRANT SELECT ON public.ops_workflow_copies, public.schedule_fire_observations, public.ops_lane_sweeps TO service_role;

-- ── ops_now ───────────────────────────────────────────────────────────────────
-- The database's clock, which every fire is computed against (#1698 D8, L736),
-- never the Worker's. Read only.
CREATE FUNCTION public.ops_now()
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$ SELECT now() $fn$;

-- ── claim_ops_sweep ───────────────────────────────────────────────────────────
-- One owner per sweep interval (#1698 1.4, from pg-boss src/plans.ts
-- trySetTimestamp, MIT, v12.35.1). A try advisory lock first, so a second tick
-- arriving while the first is claiming stands down at once rather than waiting;
-- then a compare and set on the sweep's last start, so a second tick arriving
-- after the first committed finds the interval taken. owned false is a stand
-- down, recorded by the caller, never an error.
CREATE FUNCTION public.claim_ops_sweep(p_sweep text, p_owner text, p_every_seconds integer)
RETURNS TABLE (owned boolean, db_now timestamptz, last_started_at timestamptz, last_owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_row record;
BEGIN
  IF p_sweep IS NULL OR p_sweep NOT IN ('lease_expiry', 'run_expiry', 'queue_agreement') THEN
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

-- ── save_workflow_copies ──────────────────────────────────────────────────────
-- Saves one list the bidding Worker served (decision 4), under the rules in the
-- header. p_copies is a JSON array of at most 1,000 objects:
--   {workflow_id, organization_id, is_active, deleted_at, row_updated_at,
--    version_number, trigger}
-- p_complete says the list names every ops workflow, so one it omits is
-- withdrawn. Answers one row of counts. Lane wide: the list spans organizations,
-- and each copy is matched against its stored organization. Rows are taken in
-- workflow order, so two saves at once lock in the same order.
CREATE FUNCTION public.save_workflow_copies(p_served_at timestamptz, p_complete boolean, p_copies jsonb)
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
      CASE WHEN jsonb_typeof(e->'trigger') = 'object' THEN e->'trigger' END AS trigger
    FROM jsonb_array_elements(p_copies) e
    ORDER BY (e->>'workflow_id')::uuid
  LOOP
    IF v_copy.workflow_id IS NULL OR v_copy.organization_id IS NULL OR v_copy.is_active IS NULL OR v_copy.row_updated_at IS NULL THEN
      RAISE EXCEPTION 'save_workflow_copies: a copy needs its workflow, organization, on or off state and row_updated_at' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_ids := v_ids || v_copy.workflow_id;
    v_timing := CASE WHEN v_copy.trigger->>'type' = 'schedule' THEN
      concat_ws('|', coalesce(v_copy.trigger->'config'->>'cron', ''), coalesce(v_copy.trigger->'config'->>'interval_seconds', ''),
        coalesce(v_copy.trigger->'config'->>'timezone', '')) END;
    v_off := NOT v_copy.is_active OR v_copy.deleted_at IS NOT NULL;

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
        CONTINUE;
      END IF;
      -- Another save inserted it between the read and the insert: take it as it now is.
      SELECT * INTO v_old FROM public.ops_workflow_copies c WHERE c.workflow_id = v_copy.workflow_id FOR UPDATE;
    END IF;

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
-- Every saved copy with what a tick plans from: whether a run may start from it
-- (decision 4), and each workflow's latest served slot (schedule_fires) and
-- latest observed one (schedule_fire_observations), each read over its UNIQUE
-- (workflow_id, scheduled_for) index. db_now is the clock the tick plans
-- against. Read only; at most p_limit rows, in workflow order, so the caller can
-- tell a full page (L24).
CREATE FUNCTION public.workflow_copies(p_limit integer)
RETURNS TABLE (
  workflow_id uuid, organization_id uuid, is_active boolean, deleted_at timestamptz, withdrawn_at timestamptz,
  row_updated_at timestamptz, version_number integer, trigger jsonb, schedule_known_since timestamptz,
  switched_off_at timestamptz, served_at timestamptz, received_at timestamptz, confirmed_at timestamptz,
  may_start boolean, last_served timestamptz, last_observed timestamptz, db_now timestamptz
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
    now()
  FROM public.ops_workflow_copies c
  ORDER BY c.workflow_id
  LIMIT p_limit;
END
$fn$;

-- ── record_schedule_observation ───────────────────────────────────────────────
-- One slot the tick would have fired, or reported missed, in observe mode.
-- UNIQUE (workflow_id, scheduled_for) absorbs a doubled or overlapping tick:
-- the second answers already_recorded, so only the first dispatches.
CREATE FUNCTION public.record_schedule_observation(
  p_organization_id         uuid,
  p_workflow_id             uuid,
  p_workflow_version        integer,
  p_scheduled_for           timestamptz,
  p_outcome                 text,
  p_reason                  text,
  p_dispatch_at             timestamptz,
  p_previous_scheduled_for  timestamptz,
  p_tick_id                 text
) RETURNS TABLE (outcome text, observation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_found record;
BEGIN
  IF p_organization_id IS NULL OR p_workflow_id IS NULL OR p_workflow_version IS NULL OR p_scheduled_for IS NULL THEN
    RAISE EXCEPTION 'record_schedule_observation: organization, workflow, version and slot are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.schedule_fire_observations (organization_id, workflow_id, workflow_version, scheduled_for, outcome, reason,
    dispatch_at, previous_scheduled_for, tick_id)
  VALUES (p_organization_id, p_workflow_id, p_workflow_version, p_scheduled_for, p_outcome, p_reason, p_dispatch_at,
    p_previous_scheduled_for, p_tick_id)
  ON CONFLICT ON CONSTRAINT schedule_fire_observations_slot_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT 'recorded'::text, v_id;
    RETURN;
  END IF;
  SELECT o.id, o.organization_id INTO v_found FROM public.schedule_fire_observations o
  WHERE o.workflow_id = p_workflow_id AND o.scheduled_for = p_scheduled_for;
  IF v_found.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'record_schedule_observation: this slot belongs to another organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT 'already_recorded'::text, v_found.id;
END
$fn$;

-- ── due_queue_depth ───────────────────────────────────────────────────────────
-- What a claim would find now: the due waiting runs and how many workflows they
-- belong to, over run_queue_due_idx. Observe mode records this in place of
-- claiming. Read only.
CREATE FUNCTION public.due_queue_depth()
RETURNS TABLE (due_runs bigint, due_workflows bigint, oldest_due timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT count(*), count(DISTINCT q.workflow_id), min(q.not_before) FROM public.run_queue q WHERE q.not_before <= now()
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'ops_now', 'claim_ops_sweep', 'save_workflow_copies', 'workflow_copies', 'record_schedule_observation', 'due_queue_depth')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;
