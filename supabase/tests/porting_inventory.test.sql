-- The porting schema's inventory and workflow map (#1710, plan 0.F).
--
-- WHY. The inventory holds one row per Pipedream workflow and two facts that must
-- never share a field (L53): what Pipedream says (pipedream_state, refreshed from
-- each export) and how far Bidspoke has taken it (porting_stage, advanced only by
-- Bidspoke). Neither table is for the browser: RLS is on with no policy, and anon
-- and authenticated are revoked by name, because a platform default grant can
-- already give away what a migration never granted (L124, L541). The schema is
-- exposed to the Data API so the service role's scripts and Worker can reach it.
--
-- HOW. Catalogue checks for RLS, privileges and the exposed schema list, then
-- behaviour inside a rolled back transaction: a new row starts at porting_stage
-- 'none', an unknown state is refused, and the map refuses a second row for the
-- same hashid, role and trigger index (L393). Then the decisions (#2979): a
-- retired stage refused without who, why and when, a dropped step refused without
-- who and why, and both kept through the loader's upsert of a newer export.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_workflow uuid;
  v_stage text;
  v_table text;
  v_role text;
  v_priv text;
  v_schemas text;
  v_refused boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['porting.pipedream_inventory', 'porting.pipedream_workflow_map'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN
      RAISE EXCEPTION '% does not have row level security enabled', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname || '.' || tablename = v_table) THEN
      RAISE EXCEPTION '% has a policy; it is for the service role only', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION '% holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_table, v_priv) THEN
        RAISE EXCEPTION 'service_role lacks % on %', v_priv, v_table;
      END IF;
    END LOOP;
  END LOOP;

  IF has_schema_privilege('anon', 'porting', 'USAGE') OR has_schema_privilege('authenticated', 'porting', 'USAGE') THEN
    RAISE EXCEPTION 'anon or authenticated holds USAGE on the porting schema';
  END IF;
  IF NOT has_schema_privilege('service_role', 'porting', 'USAGE') THEN
    RAISE EXCEPTION 'service_role lacks USAGE on the porting schema';
  END IF;

  -- The Data API's exposed schemas: exactly what the dashboard exposed before
  -- (measured 2026-10-06: public, graphql_public), plus porting.
  SELECT substring(c FROM '^pgrst\.db_schemas=(.*)$') INTO v_schemas
  FROM pg_roles r, unnest(r.rolconfig) c
  WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  IF v_schemas IS DISTINCT FROM 'public, graphql_public, porting' THEN
    RAISE EXCEPTION 'authenticator pgrst.db_schemas is %, expected public, graphql_public, porting', coalesce(v_schemas, 'unset');
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES ('Porting inventory test org', 'porting-inventory-test-' || gen_random_uuid())
  RETURNING id INTO v_org;

  INSERT INTO porting.pipedream_inventory (organization_id, pipedream_hashid, project_hashid, name, pipedream_state, definition_sha256, trigger_types, step_count, deployment_count, first_seen_export_at, last_seen_export_at)
  VALUES (v_org, 'p_test001', 'proj_test', 'A test workflow', 'on', repeat('a', 64), ARRAY['http'], 3, 0, '2026-09-30T19:26:13Z', '2026-09-30T19:26:13Z')
  RETURNING porting_stage INTO v_stage;
  IF v_stage IS DISTINCT FROM 'none' THEN
    RAISE EXCEPTION 'a new inventory row starts at porting_stage %, expected none', v_stage;
  END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.pipedream_inventory (organization_id, pipedream_hashid, project_hashid, name, pipedream_state, definition_sha256, trigger_types, step_count, deployment_count, first_seen_export_at, last_seen_export_at)
    VALUES (v_org, 'p_test002', 'proj_test', 'Bad state', 'paused', NULL, ARRAY[]::text[], 0, 0, '2026-09-30T19:26:13Z', '2026-09-30T19:26:13Z');
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'pipedream_state paused was accepted'; END IF;

  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'ported' WHERE pipedream_hashid = 'p_test001';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'porting_stage ported was accepted'; END IF;

  INSERT INTO public.workflows (organization_id, name) VALUES (v_org, 'Port target') RETURNING id INTO v_workflow;
  INSERT INTO porting.pipedream_workflow_map (pipedream_hashid, role, trigger_index, workflow_id)
  VALUES ('p_test001', 'whole', 0, v_workflow);

  v_refused := false;
  BEGIN
    INSERT INTO porting.pipedream_workflow_map (pipedream_hashid, role, trigger_index, workflow_id)
    VALUES ('p_test001', 'whole', 0, v_workflow);
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a second whole row for one hashid was accepted'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.pipedream_workflow_map (pipedream_hashid, role, trigger_index, workflow_id)
    VALUES ('p_test001', 'whole', 1, v_workflow);
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a whole row with trigger_index 1 was accepted'; END IF;

  v_refused := false;
  BEGIN
    INSERT INTO porting.pipedream_workflow_map (pipedream_hashid, role, trigger_index, workflow_id)
    VALUES ('p_unknown', 'whole', 0, v_workflow);
  EXCEPTION WHEN foreign_key_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a map row for a hashid not in the inventory was accepted'; END IF;

  RAISE NOTICE 'porting_inventory: 9 cases passed';
END $$;

-- A workflow that will not be ported, and a step left out of a port (#2979).
-- Dan decides both when he ports; the database holds the decision's shape: a
-- retired stage carries who decided, why and when, a dropped step carries the
-- same, and the loader's upsert, which names only the export's columns, leaves
-- both exactly as recorded.
DO $$
DECLARE
  v_org uuid;
  v_role text;
  v_priv text;
  v_refused boolean;
  v_row record;
  v_count integer;
  v_cases integer := 0;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'porting.dropped_steps'::regclass) THEN
    RAISE EXCEPTION 'porting.dropped_steps does not have row level security enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'porting' AND tablename = 'dropped_steps') THEN
    RAISE EXCEPTION 'porting.dropped_steps has a policy; it is for the service role only';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'porting.dropped_steps', v_priv) THEN
        RAISE EXCEPTION '% holds % on porting.dropped_steps', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'porting.dropped_steps', v_priv) THEN
      RAISE EXCEPTION 'service_role lacks % on porting.dropped_steps', v_priv;
    END IF;
  END LOOP;
  -- A drop is recorded once: corrected by a delete and a new row, never rewritten.
  IF has_table_privilege('service_role', 'porting.dropped_steps', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role holds UPDATE on porting.dropped_steps';
  END IF;
  v_cases := v_cases + 1;

  INSERT INTO public.organizations (name, slug)
  VALUES ('Porting decisions test org', 'porting-decisions-test-' || gen_random_uuid())
  RETURNING id INTO v_org;
  INSERT INTO porting.pipedream_inventory (organization_id, pipedream_hashid, project_hashid, name, pipedream_state, definition_sha256, trigger_types, step_count, deployment_count, first_seen_export_at, last_seen_export_at)
  VALUES (v_org, 'p_retire01', 'proj_test', 'A workflow to retire', 'on', repeat('c', 64), ARRAY['http'], 4, 1, '2026-09-30T19:26:13Z', '2026-09-30T19:26:13Z');

  -- Retired without who decided, without why, or with a blank reason: refused.
  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'retired', retired_reason = 'Behind an End Workflow', retired_at = now() WHERE pipedream_hashid = 'p_retire01';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a retired stage without who decided was accepted'; END IF;
  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'retired', retired_by = 'Test person', retired_at = now() WHERE pipedream_hashid = 'p_retire01';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a retired stage without a reason was accepted'; END IF;
  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'retired', retired_by = 'Test person', retired_reason = '  ', retired_at = now() WHERE pipedream_hashid = 'p_retire01';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a retired stage with a blank reason was accepted'; END IF;
  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET porting_stage = 'retired', retired_by = 'Test person', retired_reason = 'Dead' WHERE pipedream_hashid = 'p_retire01';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a retired stage without when was accepted'; END IF;
  -- A decision on a workflow that is not retired: refused, so a stale who and why cannot linger.
  v_refused := false;
  BEGIN
    UPDATE porting.pipedream_inventory SET retired_by = 'Test person', retired_reason = 'Dead', retired_at = now() WHERE pipedream_hashid = 'p_retire01';
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'who retired it was accepted on a workflow at porting_stage none'; END IF;
  v_cases := v_cases + 5;

  UPDATE porting.pipedream_inventory
  SET porting_stage = 'retired', retired_by = 'Test person', retired_reason = 'Only calls the retired Assistants API', retired_at = '2026-10-28T12:00:00Z'
  WHERE pipedream_hashid = 'p_retire01';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'retiring with who, why and when wrote % rows, expected 1', v_count; END IF;
  v_cases := v_cases + 1;

  -- A dropped step: who and why required, once per step, only for a workflow in the inventory.
  INSERT INTO porting.dropped_steps (pipedream_hashid, step, dropped_by, reason)
  VALUES ('p_retire01', 'normalize_thread_id', 'Test person', 'Reads a legacy thread the API deleted');
  v_refused := false;
  BEGIN
    INSERT INTO porting.dropped_steps (pipedream_hashid, step, dropped_by, reason)
    VALUES ('p_retire01', 'normalize_thread_id', 'Someone else', 'Again');
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a second drop of one step was accepted'; END IF;
  v_refused := false;
  BEGIN
    INSERT INTO porting.dropped_steps (pipedream_hashid, step, dropped_by, reason) VALUES ('p_retire01', 'other_step', 'Test person', NULL);
  EXCEPTION WHEN not_null_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a dropped step without a reason was accepted'; END IF;
  v_refused := false;
  BEGIN
    INSERT INTO porting.dropped_steps (pipedream_hashid, step, dropped_by, reason) VALUES ('p_retire01', 'other_step', ' ', 'Dead');
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a dropped step with a blank who was accepted'; END IF;
  v_refused := false;
  BEGIN
    INSERT INTO porting.dropped_steps (pipedream_hashid, step, dropped_by, reason) VALUES ('p_unknown', 'a_step', 'Test person', 'Dead');
  EXCEPTION WHEN foreign_key_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a dropped step of a workflow not in the inventory was accepted'; END IF;
  v_cases := v_cases + 4;

  -- A reload of a newer export: the loader upserts every export column it
  -- writes (packages/porting-evidence INVENTORY_COLUMNS) as PostgREST's
  -- merge-duplicates does, an INSERT ON CONFLICT updating only those columns.
  INSERT INTO porting.pipedream_inventory (organization_id, pipedream_hashid, project_hashid, name, pipedream_state, definition_sha256, trigger_types, step_count, deployment_count, first_seen_export_at, last_seen_export_at, absent_since_export_at, updated_at)
  VALUES (v_org, 'p_retire01', 'proj_test', 'A workflow to retire, renamed', 'off', repeat('d', 64), ARRAY['http'], 5, 1, '2026-09-30T19:26:13Z', '2026-11-30T10:00:00Z', NULL, now())
  ON CONFLICT (pipedream_hashid) DO UPDATE SET
    organization_id = EXCLUDED.organization_id, project_hashid = EXCLUDED.project_hashid, name = EXCLUDED.name,
    pipedream_state = EXCLUDED.pipedream_state, definition_sha256 = EXCLUDED.definition_sha256, trigger_types = EXCLUDED.trigger_types,
    step_count = EXCLUDED.step_count, deployment_count = EXCLUDED.deployment_count, first_seen_export_at = EXCLUDED.first_seen_export_at,
    last_seen_export_at = EXCLUDED.last_seen_export_at, absent_since_export_at = EXCLUDED.absent_since_export_at, updated_at = EXCLUDED.updated_at;
  SELECT porting_stage, retired_by, retired_reason, retired_at, pipedream_state INTO v_row FROM porting.pipedream_inventory WHERE pipedream_hashid = 'p_retire01';
  IF v_row.pipedream_state IS DISTINCT FROM 'off' THEN RAISE EXCEPTION 'the reload did not land: pipedream_state is %', v_row.pipedream_state; END IF;
  IF v_row.porting_stage IS DISTINCT FROM 'retired' OR v_row.retired_by IS DISTINCT FROM 'Test person'
     OR v_row.retired_reason IS DISTINCT FROM 'Only calls the retired Assistants API' OR v_row.retired_at IS DISTINCT FROM '2026-10-28T12:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'a reload changed the retirement: %', row_to_json(v_row);
  END IF;
  SELECT count(*) INTO v_count FROM porting.dropped_steps WHERE pipedream_hashid = 'p_retire01' AND step = 'normalize_thread_id' AND dropped_by = 'Test person';
  IF v_count <> 1 THEN RAISE EXCEPTION 'a reload lost the dropped step (% rows)', v_count; END IF;
  v_cases := v_cases + 1;

  -- Undoing a retirement clears who and why with the stage.
  UPDATE porting.pipedream_inventory SET porting_stage = 'none', retired_by = NULL, retired_reason = NULL, retired_at = NULL WHERE pipedream_hashid = 'p_retire01';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'undoing a retirement wrote % rows, expected 1', v_count; END IF;
  v_cases := v_cases + 1;

  RAISE NOTICE 'porting_inventory decisions: % cases passed', v_cases;
END $$;

ROLLBACK;
