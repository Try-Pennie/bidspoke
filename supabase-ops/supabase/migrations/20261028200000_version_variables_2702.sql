-- A workflow version's variables, kept beside its frozen definition (#2702).
--
-- Dan's decisions of 2026-10-28 on #2702: an ops run's plain environment
-- variables are frozen with the workflow version, as its definition is, so a
-- run uses what was saved, a change takes effect at the next save, and a run
-- never reads the bidding database for them; and an ops run never receives a
-- secret variable, so of a secret only its name arrives, for the run to refuse
-- it by name. The bidding Worker serves them with the version's definition
-- (OpsGateway.opsWorkflowDefinitions, as { values, secret_keys }), and ops
-- keeps them here beside it, so a run has them through a bidding outage.
--
-- 1. ops_workflow_definitions.variables, nullable: { values, secret_keys } as
--    served, or null for a version served with none (saved on bidding before
--    #2702, or served by a bidding Worker from before it). Only an object.
-- 2. save_workflow_definition gains p_variables, defaulting to null, and a
--    held version whose variables differ from those served is a conflict, as
--    a different definition is: a saved version never changes. Replaced with
--    DROP and CREATE, since the argument list changes; the call the ops Worker
--    made before #2702 names four arguments and resolves to this one.
-- 3. workflow_definition also answers the variables. Replaced with DROP and
--    CREATE, since its result columns change; a reader from before #2702
--    reads definition and saved_at by name and ignores the new column.
--
-- Expand only (ADR 0007), safe in either order with the ops Worker: the
-- running Worker's calls resolve to the new functions unchanged, and a Worker
-- from #2702 deployed first names p_variables only for a version served with
-- some (none exists until the bidding migration of #2702 is applied and an ops
-- workflow saved), and reads a missing variables column as none held, which
-- refuses by name any run whose definition reads a variable.
--
-- Guarded by supabase-ops/supabase/tests/version_variables.test.sql.

SET lock_timeout = '10s';

ALTER TABLE public.ops_workflow_definitions
  ADD COLUMN IF NOT EXISTS variables jsonb NULL
  CONSTRAINT ops_workflow_definitions_variables_check CHECK (variables IS NULL OR jsonb_typeof(variables) = 'object'),
  -- Variables are a handful of short values, never a data store: 1 MB is far past any we hold.
  ADD CONSTRAINT ops_workflow_definitions_variables_size CHECK (variables IS NULL OR octet_length(variables::text) <= 1048576);

COMMENT ON COLUMN public.ops_workflow_definitions.variables IS
  'The environment variables the version''s definition reads, as served with it and kept at its save on bidding: { values: { NAME: text }, secret_keys: [NAME] } (#2702). Null for a version served with none.';

DROP FUNCTION public.save_workflow_definition(uuid, uuid, integer, jsonb);

-- One version's definition and variables, as served. Answers saved,
-- already_saved (the same definition and variables are held), conflict (a
-- different definition or different variables are held, and are kept), or
-- no_copy (no saved copy of this workflow). A workflow whose copy is another
-- organization's is refused (insufficient_privilege).
CREATE FUNCTION public.save_workflow_definition(
  p_organization_id  uuid,
  p_workflow_id      uuid,
  p_version_number   integer,
  p_definition       jsonb,
  p_variables        jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_held record;
  v_copy_org uuid;
BEGIN
  IF p_version_number IS NULL OR p_version_number < 1 THEN
    RAISE EXCEPTION 'save_workflow_definition: a version of 1 or more is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_definition IS NULL OR jsonb_typeof(p_definition) <> 'object' THEN
    RAISE EXCEPTION 'save_workflow_definition: a definition is a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_variables IS NOT NULL AND jsonb_typeof(p_variables) <> 'object' THEN
    RAISE EXCEPTION 'save_workflow_definition: a version''s variables are a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.organization_id INTO v_copy_org FROM public.ops_workflow_copies c WHERE c.workflow_id = p_workflow_id;
  IF NOT FOUND THEN
    RETURN 'no_copy';
  END IF;
  IF v_copy_org <> p_organization_id THEN
    RAISE EXCEPTION 'save_workflow_definition: workflow % is not this organization''s', p_workflow_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ops_workflow_definitions (workflow_id, version_number, organization_id, definition, variables)
  VALUES (p_workflow_id, p_version_number, p_organization_id, p_definition, p_variables)
  ON CONFLICT ON CONSTRAINT ops_workflow_definitions_pkey DO NOTHING;
  IF FOUND THEN
    RETURN 'saved';
  END IF;
  SELECT d.definition, d.variables INTO v_held FROM public.ops_workflow_definitions d
  WHERE d.workflow_id = p_workflow_id AND d.version_number = p_version_number AND d.organization_id = p_organization_id;
  IF NOT FOUND THEN
    -- Held under another organization, against what the copy says: refused, never answered.
    RAISE EXCEPTION 'save_workflow_definition: workflow % version % is held for another organization', p_workflow_id, p_version_number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN v_held.definition = p_definition AND v_held.variables IS NOT DISTINCT FROM p_variables THEN 'already_saved' ELSE 'conflict' END;
END
$fn$;

DROP FUNCTION public.workflow_definition(uuid, uuid, integer);

-- One version of one organization's workflow, with its variables; no row when it is not held.
CREATE FUNCTION public.workflow_definition(p_organization_id uuid, p_workflow_id uuid, p_version_number integer)
RETURNS TABLE (definition jsonb, saved_at timestamptz, variables jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT d.definition, d.saved_at, d.variables FROM public.ops_workflow_definitions d
  WHERE d.organization_id = p_organization_id AND d.workflow_id = p_workflow_id AND d.version_number = p_version_number;
$fn$;

REVOKE ALL ON FUNCTION public.save_workflow_definition(uuid, uuid, integer, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_workflow_definition(uuid, uuid, integer, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.workflow_definition(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_definition(uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
