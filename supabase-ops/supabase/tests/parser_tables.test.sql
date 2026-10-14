-- The file parser monitor's two tables (#2068): parser_runs and parser_registry.
--
-- WHY. Both were created by hand on the live ops project on 2026-10-13, outside any
-- migration, with row level security off and no organization_id, so the live
-- privilege check (.github/scripts/db-privilege-check.mjs) failed on every push to
-- main from then on. Something writes parser_runs as the service role and inserts
-- without naming an organization, so the column arrives with Pennie's organization
-- as its default: a NOT NULL column with no default would stop that writer on its
-- next insert.
--
-- HOW. Catalogue checks for the rules the live check applies, then the writer's own
-- shape of insert (no organization_id, no id) as the service role inside a rolled
-- back transaction, asserting it lands with the default organization and a minted id.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops).

BEGIN;

DO $$
DECLARE
  v_table text;
  v_role text;
  v_org uuid;
  v_id bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.parser_runs', 'public.parser_registry'] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION '% does not exist', v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN
      RAISE EXCEPTION '% has row level security off', v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = v_table::regclass AND a.attname = 'organization_id' AND a.attnotnull
        AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
      RAISE EXCEPTION '% has no organization_id uuid NOT NULL column', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION '% holds a privilege on %', v_role, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'service_role lacks a privilege on %', v_table;
    END IF;
  END LOOP;

  -- The writer's insert: no organization_id, no id.
  SET LOCAL ROLE service_role;
  INSERT INTO public.parser_registry (parser, label, cadence, expected_by)
  VALUES ('suite_probe', 'Suite probe', 'daily', '09:00')
  RETURNING organization_id INTO v_org;
  IF v_org IS DISTINCT FROM '9d9d0d3a-1959-41d5-95ca-c1399fa54590'::uuid THEN
    RAISE EXCEPTION 'a registry row written without an organization got %, expected Pennie''s', v_org;
  END IF;
  INSERT INTO public.parser_runs (parser, run_at, status, envelope)
  VALUES ('suite_probe', now(), 'ok', '{}'::jsonb)
  RETURNING id, organization_id INTO v_id, v_org;
  IF v_id IS NULL OR v_org IS DISTINCT FROM '9d9d0d3a-1959-41d5-95ca-c1399fa54590'::uuid THEN
    RAISE EXCEPTION 'a run written without an organization got id % and organization %', v_id, v_org;
  END IF;
  RESET ROLE;

  RAISE NOTICE 'parser_tables: 14 cases passed';
END $$;

ROLLBACK;
