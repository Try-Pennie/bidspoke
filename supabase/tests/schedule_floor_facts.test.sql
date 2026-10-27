-- The facts a ported schedule's floor is taken from (#1952, #1698 D8): when a
-- Pipedream workflow was cut over, and which Bidspoke workflow replaces which.
--
-- WHY. A ported schedule must never fire a period Pipedream already ran, and a
-- workflow minted under a new id must never fire a slot the id it replaces
-- already served. The ops tick reads both facts through the bidding Worker's
-- gateway, so they must hold their shape here: a cutover time on a Pipedream
-- workflow that is not cut over would let a port fire while Pipedream still
-- runs, and a replacement across organizations would lift one organization's
-- floor from another's runs.
--
-- HOW. Catalogue checks for the new table's row level security and privileges,
-- then behaviour inside a rolled back transaction.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_other_org uuid;
  v_old uuid;
  v_new uuid;
  v_foreign uuid;
  v_role text;
  v_priv text;
  v_refused boolean;
  v_count integer;
BEGIN
  -- ── the table's privileges ──────────────────────────────────────────────────
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'porting.workflow_replacements'::regclass) THEN
    RAISE EXCEPTION 'porting.workflow_replacements does not have row level security enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'porting' AND tablename = 'workflow_replacements') THEN
    RAISE EXCEPTION 'porting.workflow_replacements has a policy; it is for the service role only';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'porting.workflow_replacements', v_priv) THEN
        RAISE EXCEPTION '% holds % on porting.workflow_replacements', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'porting.workflow_replacements', v_priv) THEN
      RAISE EXCEPTION 'service_role lacks % on porting.workflow_replacements', v_priv;
    END IF;
  END LOOP;
  -- A replacement is a fact recorded once: corrected by a delete and a new row, never rewritten.
  IF has_table_privilege('service_role', 'porting.workflow_replacements', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role holds UPDATE on porting.workflow_replacements';
  END IF;

  INSERT INTO public.organizations (name, slug) VALUES ('Schedule floor test org', 'schedule-floor-test-' || gen_random_uuid()) RETURNING id INTO v_org;
  INSERT INTO public.organizations (name, slug) VALUES ('Schedule floor other org', 'schedule-floor-other-' || gen_random_uuid()) RETURNING id INTO v_other_org;

  -- ── cut_over_at belongs to a Pipedream workflow that is cut over ────────────
  INSERT INTO porting.pipedream_inventory (organization_id, pipedream_hashid, project_hashid, name, pipedream_state, definition_sha256, trigger_types, step_count, deployment_count, first_seen_export_at, last_seen_export_at)
  VALUES (v_org, 'p_floor001', 'proj_floor', 'A scheduled workflow', 'on', repeat('b', 64), ARRAY['timer'], 2, 1, '2026-09-30T19:26:13Z', '2026-09-30T19:26:13Z');

  SELECT count(*) INTO v_count FROM porting.pipedream_inventory WHERE pipedream_hashid = 'p_floor001' AND cut_over_at IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'a new inventory row has a cutover time'; END IF;

  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET cut_over_at = '2026-10-27T14:00:00Z' WHERE pipedream_hashid = 'p_floor001';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a cutover time on a workflow at porting_stage none was accepted'; END IF;

  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'drafted', cut_over_at = '2026-10-27T14:00:00Z' WHERE pipedream_hashid = 'p_floor001';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a cutover time on a drafted workflow was accepted'; END IF;

  UPDATE porting.pipedream_inventory SET porting_stage = 'cut_over', cut_over_at = '2026-10-27T14:00:00Z' WHERE pipedream_hashid = 'p_floor001';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'a cutover time on a cut over workflow was not written'; END IF;
  UPDATE porting.pipedream_inventory SET porting_stage = 'settled' WHERE pipedream_hashid = 'p_floor001';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'a settled workflow could not keep its cutover time'; END IF;

  -- ── workflow_replacements ───────────────────────────────────────────────────
  INSERT INTO public.workflows (organization_id, name) VALUES (v_org, 'Old port') RETURNING id INTO v_old;
  INSERT INTO public.workflows (organization_id, name) VALUES (v_org, 'New port') RETURNING id INTO v_new;
  INSERT INTO public.workflows (organization_id, name) VALUES (v_other_org, 'Another organization''s workflow') RETURNING id INTO v_foreign;

  INSERT INTO porting.workflow_replacements (workflow_id, replaces_workflow_id) VALUES (v_new, v_old);
  SELECT count(*) INTO v_count FROM porting.workflow_replacements WHERE workflow_id = v_new AND replaces_workflow_id = v_old AND recorded_at IS NOT NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'a replacement was not recorded with its time'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.workflow_replacements (workflow_id, replaces_workflow_id) VALUES (v_new, v_old);
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the same replacement was recorded twice'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.workflow_replacements (workflow_id, replaces_workflow_id) VALUES (v_new, v_new);
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a workflow recorded as replacing itself was accepted'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.workflow_replacements (workflow_id, replaces_workflow_id) VALUES (v_new, v_foreign);
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a replacement of another organization''s workflow was accepted'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.workflow_replacements (workflow_id, replaces_workflow_id) VALUES (v_new, gen_random_uuid());
  EXCEPTION WHEN foreign_key_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a replacement of a workflow that does not exist was accepted'; END IF;

  RAISE NOTICE 'schedule_floor_facts: 11 cases passed';
END $$;

ROLLBACK;
