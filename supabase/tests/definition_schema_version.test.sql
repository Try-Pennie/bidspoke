-- definition_schema_version on workflows and workflow_versions (#1947).
--
-- WHY. The stamp says which rules a stored definition is judged by. An absent
-- stamp is a real value, unstamped, which the reader (readSchemaStamp in
-- @bidspoke/workflow-definition) judges as version 1, so the column must stay
-- nullable with no default: a default would label every row the old code
-- writes during the deploy window as checked under rules it never met. A
-- present stamp is a version, so it is a whole number from 1.
--
-- HOW. The catalogue is read for the type, nullability and default, and rows
-- are written inside a transaction that is rolled back: a row written without
-- the column stores NULL, a stamp of 1 or 2 is kept, and 0 or -1 is refused by
-- the CHECK, on both tables.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

BEGIN;

DO $$
DECLARE
  v_table text;
  v_type text;
  v_nullable text;
  v_default text;
  v_org uuid;
  v_wf uuid;
  v_stamp smallint;
  v_bad smallint;
  v_refused boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['workflows', 'workflow_versions'] LOOP
    SELECT data_type, is_nullable, column_default INTO v_type, v_nullable, v_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'definition_schema_version';
    IF v_type IS NULL THEN
      RAISE EXCEPTION '%.definition_schema_version does not exist', v_table;
    END IF;
    IF v_type <> 'smallint' THEN
      RAISE EXCEPTION '%.definition_schema_version is %, expected smallint', v_table, v_type;
    END IF;
    IF v_nullable <> 'YES' THEN
      RAISE EXCEPTION '%.definition_schema_version is NOT NULL: an unstamped row could not be written', v_table;
    END IF;
    IF v_default IS NOT NULL THEN
      RAISE EXCEPTION '%.definition_schema_version has default %: a row the old code writes would read as stamped', v_table, v_default;
    END IF;
  END LOOP;

  INSERT INTO public.organizations (name, slug)
  VALUES ('Schema stamp test org', 'schema-stamp-test-' || gen_random_uuid())
  RETURNING id INTO v_org;

  -- A writer that names no stamp stores none.
  INSERT INTO public.workflows (organization_id, name)
  VALUES (v_org, 'Written without a stamp')
  RETURNING id, definition_schema_version INTO v_wf, v_stamp;
  IF v_stamp IS NOT NULL THEN
    RAISE EXCEPTION 'a workflow written without a stamp stored %, expected NULL', v_stamp;
  END IF;

  INSERT INTO public.workflow_versions (workflow_id, version_number, definition)
  VALUES (v_wf, 1, '{}'::jsonb)
  RETURNING definition_schema_version INTO v_stamp;
  IF v_stamp IS NOT NULL THEN
    RAISE EXCEPTION 'a version written without a stamp stored %, expected NULL', v_stamp;
  END IF;

  -- A stamp is kept as written, including one newer than this build knows.
  UPDATE public.workflows SET definition_schema_version = 1 WHERE id = v_wf RETURNING definition_schema_version INTO v_stamp;
  IF v_stamp IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'workflows kept stamp %, expected 1', v_stamp;
  END IF;
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition, definition_schema_version)
  VALUES (v_wf, 2, '{}'::jsonb, 2)
  RETURNING definition_schema_version INTO v_stamp;
  IF v_stamp IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'workflow_versions kept stamp %, expected 2', v_stamp;
  END IF;

  -- Zero and below are no version at all.
  FOREACH v_bad IN ARRAY ARRAY[0, -1]::smallint[] LOOP
    v_refused := false;
    BEGIN
      UPDATE public.workflows SET definition_schema_version = v_bad WHERE id = v_wf;
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'workflows accepted stamp %', v_bad;
    END IF;

    v_refused := false;
    BEGIN
      INSERT INTO public.workflow_versions (workflow_id, version_number, definition, definition_schema_version)
      VALUES (v_wf, 10 + abs(v_bad), '{}'::jsonb, v_bad);
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'workflow_versions accepted stamp %', v_bad;
    END IF;
  END LOOP;

  RAISE NOTICE 'definition_schema_version: 8 column checks (4 on each of 2 tables), 8 row cases passed';
END $$;

ROLLBACK;
