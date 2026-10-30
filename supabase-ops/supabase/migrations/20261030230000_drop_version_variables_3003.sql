-- Drop the variables kept beside an ops version's definition (#3003), the
-- contract step of #2982 after 20261028200000_version_variables_2702.sql.
--
-- Since #2982 a run reads each variable's current value when it starts,
-- carried in its dispatch (Dan's decisions of 2026-10-28 and 29), so what a
-- version kept is read by nothing. The expand half is live: #3044 (deployed
-- 2026-10-30) stopped the ops Worker sending p_variables and reading the
-- variables workflow_definition answers.
--
-- 1. save_workflow_definition loses p_variables and compares only the
--    definition: the same one again is already_saved, a different one is
--    conflict. Replaced with DROP and CREATE, since the argument list changes;
--    the ops Worker's call names four arguments and resolves to this one.
-- 2. workflow_definition answers the definition and saved_at, as before #2702.
--    Replaced with DROP and CREATE, since its result columns change; the ops
--    Worker reads definition and saved_at by name.
-- 3. ops_workflow_definitions.variables is dropped, with its two checks.
--
-- What is lost: measured read only in production on 2026-10-30, 0 of 0 held
-- definitions (0 workflow copies). Each value would have been a copy of what
-- the bidding Worker served at a save, which nothing reads.
--
-- Safe before or after the ops Worker of #3003 deploys, which makes the same
-- calls as the one deployed. All in one transaction, so no call sees the
-- functions missing. Guarded by
-- supabase-ops/supabase/tests/drop_version_variables.test.sql.

SET lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.save_workflow_definition(uuid, uuid, integer, jsonb, jsonb);

-- One version's definition, as served. Answers saved, already_saved (the same
-- definition is held), conflict (a different definition is held, and is kept),
-- or no_copy (no saved copy of this workflow). A workflow whose copy is another
-- organization's is refused (insufficient_privilege).
CREATE OR REPLACE FUNCTION public.save_workflow_definition(
  p_organization_id  uuid,
  p_workflow_id      uuid,
  p_version_number   integer,
  p_definition       jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_held jsonb;
  v_copy_org uuid;
BEGIN
  IF p_version_number IS NULL OR p_version_number < 1 THEN
    RAISE EXCEPTION 'save_workflow_definition: a version of 1 or more is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_definition IS NULL OR jsonb_typeof(p_definition) <> 'object' THEN
    RAISE EXCEPTION 'save_workflow_definition: a definition is a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.organization_id INTO v_copy_org FROM public.ops_workflow_copies c WHERE c.workflow_id = p_workflow_id;
  IF NOT FOUND THEN
    RETURN 'no_copy';
  END IF;
  IF v_copy_org <> p_organization_id THEN
    RAISE EXCEPTION 'save_workflow_definition: workflow % is not this organization''s', p_workflow_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ops_workflow_definitions (workflow_id, version_number, organization_id, definition)
  VALUES (p_workflow_id, p_version_number, p_organization_id, p_definition)
  ON CONFLICT ON CONSTRAINT ops_workflow_definitions_pkey DO NOTHING;
  IF FOUND THEN
    RETURN 'saved';
  END IF;
  SELECT d.definition INTO v_held FROM public.ops_workflow_definitions d
  WHERE d.workflow_id = p_workflow_id AND d.version_number = p_version_number AND d.organization_id = p_organization_id;
  IF NOT FOUND THEN
    -- Held under another organization, against what the copy says: refused, never answered.
    RAISE EXCEPTION 'save_workflow_definition: workflow % version % is held for another organization', p_workflow_id, p_version_number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN v_held = p_definition THEN 'already_saved' ELSE 'conflict' END;
END
$fn$;

DROP FUNCTION IF EXISTS public.workflow_definition(uuid, uuid, integer);

-- One version of one organization's workflow; no row when it is not held.
CREATE FUNCTION public.workflow_definition(p_organization_id uuid, p_workflow_id uuid, p_version_number integer)
RETURNS TABLE (definition jsonb, saved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT d.definition, d.saved_at FROM public.ops_workflow_definitions d
  WHERE d.organization_id = p_organization_id AND d.workflow_id = p_workflow_id AND d.version_number = p_version_number;
$fn$;

REVOKE ALL ON FUNCTION public.save_workflow_definition(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_workflow_definition(uuid, uuid, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.workflow_definition(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_definition(uuid, uuid, integer) TO service_role;

ALTER TABLE public.ops_workflow_definitions DROP COLUMN IF EXISTS variables;

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
