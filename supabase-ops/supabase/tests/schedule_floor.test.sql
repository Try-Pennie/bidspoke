-- A ported schedule's floor in the ops copy (#1952, #1698 D8): the porting facts
-- the bidding Worker serves with each ops workflow, kept with its last good copy
-- so they hold through a bidding outage, and the last slot of the workflows it
-- replaces.
--
-- WHAT IT PROVES.
--   A. The copy's porting columns hold their shape: facts are either never told
--      (every column null) or told as of a served list; a cutover only on a
--      ported workflow; at most 50 replaced workflows.
--   B. A copy saved without porting facts (an ops release before #1952) has
--      none, which the tick reads as unknown and fires nothing from.
--   C. A copy saved with porting facts keeps them, as of the list that served them.
--   D. A later list moves them even when the workflow row did not change, so a
--      cutover recorded after the workflow was saved reaches the copy.
--   E. An older list never replaces facts a newer one served (two overlapping
--      ticks), the case where the older one says less.
--   F. A save that carries no porting facts leaves the stored ones as they are.
--   G. workflow_copies answers the latest slot fired or observed by any workflow
--      the copy replaces, within the copy's organization, and nothing for a copy
--      that replaces none.
--   H. Malformed facts are refused by name, never saved.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE sf_cases (name text PRIMARY KEY);

-- One copy, with porting facts when given. Fixed instants, so nothing depends on the clock.
CREATE FUNCTION pg_temp.sf_copy(p_wf uuid, p_org uuid, p_updated text, p_porting jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('workflow_id', p_wf, 'organization_id', p_org, 'is_active', true, 'deleted_at', NULL,
    'row_updated_at', p_updated, 'version_number', 3,
    'trigger', '{"type":"schedule","config":{"cron":"0 9 * * MON","timezone":"America/New_York","overlap":"skip","catch_up":"latest","jitter_max_seconds":0}}'::jsonb)
    || CASE WHEN p_porting IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('porting', p_porting) END
$f$;

-- ── A. The columns' shape ────────────────────────────────────────────────────
DO $do$
DECLARE
  v_stmt text;
  v_refused integer := 0;
BEGIN
  FOREACH v_stmt IN ARRAY ARRAY[
    -- told, with no served time
    $s$INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, served_at, ported) VALUES (gen_random_uuid(), gen_random_uuid(), true, now(), now(), false)$s$,
    -- a served time, with nothing told
    $s$INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, served_at, porting_served_at) VALUES (gen_random_uuid(), gen_random_uuid(), true, now(), now(), now())$s$,
    -- a cutover on a workflow that is not ported
    $s$INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, served_at, ported, porting_served_at, cutover_at) VALUES (gen_random_uuid(), gen_random_uuid(), true, now(), now(), false, now(), now())$s$,
    -- 51 replaced workflows
    $s$INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, served_at, ported, porting_served_at, replaces) VALUES (gen_random_uuid(), gen_random_uuid(), true, now(), now(), false, now(), (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 51)))$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
    END;
  END LOOP;
  IF v_refused <> 4 THEN RAISE EXCEPTION 'the porting columns refused % of 4 malformed rows', v_refused; END IF;
  INSERT INTO sf_cases VALUES ('the porting columns hold their shape');
END
$do$;

-- ── B to F. Saving the facts ─────────────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-000000001952';
  v_old uuid := '00000000-0000-4000-8000-0000000019f1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001952';
  v_r record;
BEGIN
  -- B. Saved by a release that sends no porting facts.
  PERFORM public.save_workflow_copies('2026-10-27T10:00:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z')));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.porting_served_at IS NOT NULL OR v_r.ported IS NOT NULL OR v_r.cutover_at IS NOT NULL OR v_r.replaces IS NOT NULL THEN
    RAISE EXCEPTION 'a copy saved without porting facts claims some: % % % %', v_r.porting_served_at, v_r.ported, v_r.cutover_at, v_r.replaces;
  END IF;
  INSERT INTO sf_cases VALUES ('a copy saved without porting facts has none');

  -- D. The same row, confirmed by a later list that carries facts: they arrive.
  PERFORM public.save_workflow_copies('2026-10-27T10:01:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z',
    jsonb_build_object('ported', true, 'cutover_at', NULL, 'replaces', '[]'::jsonb))));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.ported IS DISTINCT FROM true OR v_r.cutover_at IS NOT NULL OR v_r.replaces <> '{}'::uuid[] OR v_r.porting_served_at <> '2026-10-27T10:01:00Z'::timestamptz THEN
    RAISE EXCEPTION 'the facts of a confirming list were not saved: % % % %', v_r.ported, v_r.cutover_at, v_r.replaces, v_r.porting_served_at;
  END IF;
  -- The cutover is recorded later, with no change to the workflow row.
  PERFORM public.save_workflow_copies('2026-10-27T10:05:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z',
    jsonb_build_object('ported', true, 'cutover_at', '2026-10-27T10:04:00Z', 'replaces', jsonb_build_array(v_old)))));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.cutover_at IS DISTINCT FROM '2026-10-27T10:04:00Z'::timestamptz OR v_r.replaces <> ARRAY[v_old] THEN
    RAISE EXCEPTION 'a cutover recorded after the workflow was saved did not reach the copy: % %', v_r.cutover_at, v_r.replaces;
  END IF;
  INSERT INTO sf_cases VALUES ('a later list moves the facts with the workflow row unchanged');

  -- E. An older list, saved after, which read before the cutover.
  PERFORM public.save_workflow_copies('2026-10-27T10:03:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z',
    jsonb_build_object('ported', true, 'cutover_at', NULL, 'replaces', '[]'::jsonb))));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.cutover_at IS DISTINCT FROM '2026-10-27T10:04:00Z'::timestamptz OR v_r.replaces <> ARRAY[v_old] OR v_r.porting_served_at <> '2026-10-27T10:05:00Z'::timestamptz THEN
    RAISE EXCEPTION 'an older list replaced the facts a newer one served: % % %', v_r.cutover_at, v_r.replaces, v_r.porting_served_at;
  END IF;
  INSERT INTO sf_cases VALUES ('an older list never replaces newer facts');

  -- F. A newer save with no facts at all (an ops release before #1952) leaves them.
  PERFORM public.save_workflow_copies('2026-10-27T10:10:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T10:09:00Z')));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.cutover_at IS DISTINCT FROM '2026-10-27T10:04:00Z'::timestamptz OR v_r.ported IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'a save carrying no facts cleared the stored ones: % %', v_r.cutover_at, v_r.ported;
  END IF;
  INSERT INTO sf_cases VALUES ('a save carrying no facts leaves them');
END
$do$;

-- ── C. A new copy saved with facts ───────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000019e1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001952';
  v_r record;
BEGIN
  PERFORM public.save_workflow_copies('2026-10-27T11:00:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z',
    jsonb_build_object('ported', false, 'cutover_at', NULL, 'replaces', '[]'::jsonb))));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.ported IS DISTINCT FROM false OR v_r.porting_served_at IS DISTINCT FROM '2026-10-27T11:00:00Z'::timestamptz OR v_r.replaced_last_slot IS NOT NULL THEN
    RAISE EXCEPTION 'a new copy did not keep the facts it was saved with: % % %', v_r.ported, v_r.porting_served_at, v_r.replaced_last_slot;
  END IF;
  INSERT INTO sf_cases VALUES ('a new copy keeps the facts it was saved with');
END
$do$;

-- ── G. The last slot of the workflows a copy replaces ────────────────────────
DO $do$
DECLARE
  v_new uuid := '00000000-0000-4000-8000-0000000019e2';
  v_old uuid := '00000000-0000-4000-8000-0000000019e3';
  v_older uuid := '00000000-0000-4000-8000-0000000019e4';
  v_unrelated uuid := '00000000-0000-4000-8000-0000000019e5';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001952';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000001952';
  v_r record;
BEGIN
  PERFORM public.save_workflow_copies('2026-10-27T12:00:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_new, v_org, '2026-10-27T09:00:00Z',
    jsonb_build_object('ported', true, 'cutover_at', '2026-10-20T14:00:00Z', 'replaces', jsonb_build_array(v_old, v_older)))));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_new;
  IF v_r.replaced_last_slot IS NOT NULL THEN RAISE EXCEPTION 'replaced workflows with no slot gave a last slot %', v_r.replaced_last_slot; END IF;

  -- The older one fired, the old one was only observed, later; an unrelated
  -- workflow fired later still, and a row under another organization latest of all.
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for) VALUES (v_org, v_older, '2026-10-26T13:00:00Z');
  INSERT INTO public.schedule_fire_observations (organization_id, workflow_id, workflow_version, scheduled_for, outcome, reason, dispatch_at, tick_id)
    VALUES (v_org, v_old, 1, '2026-10-27T13:00:00Z', 'would_fire', 'due', '2026-10-27T13:00:00Z', 'tick-1');
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for) VALUES (v_org, v_unrelated, '2026-10-27T15:00:00Z');
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for) VALUES (v_other_org, v_old, '2026-10-27T16:00:00Z');

  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_new;
  IF v_r.replaced_last_slot IS DISTINCT FROM '2026-10-27T13:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'the last slot of the replaced workflows was %, expected the observed 13:00 within the organization', v_r.replaced_last_slot;
  END IF;
  INSERT INTO sf_cases VALUES ('the last slot of the replaced workflows, fired or observed, within the organization');
END
$do$;

-- ── H. Malformed facts are refused ───────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000019e6';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001952';
  v_bad jsonb;
  v_refused integer := 0;
BEGIN
  FOREACH v_bad IN ARRAY ARRAY[
    '"yes"'::jsonb,
    '{"ported":"true","cutover_at":null,"replaces":[]}'::jsonb,
    '{"ported":false,"cutover_at":"2026-10-27T10:00:00Z","replaces":[]}'::jsonb,
    '{"ported":true,"cutover_at":null,"replaces":"none"}'::jsonb,
    '{"ported":true,"cutover_at":null,"replaces":["not-a-uuid"]}'::jsonb,
    jsonb_build_object('ported', true, 'cutover_at', NULL, 'replaces', jsonb_build_array(v_wf))
  ] LOOP
    BEGIN
      PERFORM public.save_workflow_copies('2026-10-27T13:00:00Z', false, jsonb_build_array(pg_temp.sf_copy(v_wf, v_org, '2026-10-27T09:00:00Z', v_bad)));
    EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR check_violation THEN v_refused := v_refused + 1;
    END;
  END LOOP;
  IF v_refused <> 6 THEN RAISE EXCEPTION 'save_workflow_copies refused % of 6 malformed porting facts', v_refused; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_workflow_copies WHERE workflow_id = v_wf) THEN RAISE EXCEPTION 'a copy with malformed porting facts was saved'; END IF;
  INSERT INTO sf_cases VALUES ('malformed porting facts are refused');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM sf_cases);
BEGIN
  IF v_n <> 8 THEN RAISE EXCEPTION 'schedule_floor: % of 8 cases ran', v_n; END IF;
  RAISE NOTICE 'schedule_floor: % cases passed', v_n;
END
$do$;

ROLLBACK;
