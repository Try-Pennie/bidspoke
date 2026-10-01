-- A workflow row written without is_active starts switched off (#1706).
--
-- WHY. The create and duplicate routes now write is_active false themselves, but
-- the column default was true, so any writer that omits the field (a future
-- importer, a script, a hand written INSERT) would create a workflow that takes
-- traffic before anyone has looked at it. The default is the safe value when the
-- writer forgets (L72).
--
-- HOW. An INSERT that omits is_active is made inside a transaction and rolled
-- back, and the stored value is read back: the behaviour, not only the catalogue
-- text. The catalogue default is asserted too, so a later migration that puts
-- true back fails here by name.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_active boolean;
  v_default text;
BEGIN
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'workflows' AND column_name = 'is_active';
  IF v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'workflows.is_active default is %, expected false', coalesce(v_default, 'NULL');
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES ('Start inactive test org', 'start-inactive-test-' || gen_random_uuid())
  RETURNING id INTO v_org;

  INSERT INTO public.workflows (organization_id, name)
  VALUES (v_org, 'Written without is_active')
  RETURNING is_active INTO v_active;

  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'a workflow inserted without is_active stored %, expected false', v_active;
  END IF;

  RAISE NOTICE 'workflows_start_inactive: 2 cases passed';
END $$;

ROLLBACK;
