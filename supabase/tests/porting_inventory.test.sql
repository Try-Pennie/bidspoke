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
-- same hashid, role and trigger index (L393).
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

ROLLBACK;
