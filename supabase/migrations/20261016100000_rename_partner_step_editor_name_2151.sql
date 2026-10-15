-- A step rename names its own editor on the partner row (#2151, part of #2114).
--
-- rename_partner_step_namespace set updated_by and updated_by_email to the user
-- renaming the step, but never updated_by_name, so after a rename the partner
-- row still held the PREVIOUS editor's name, and the partners page footer
-- ("Modified ... by <name>") credited the wrong person. #2132 already stamps the
-- right name on the audit row (_actor, read from users at write time); this
-- makes the row column agree with it.
--
-- The body is 20260921221007's, which is the only definition before this one
-- and matches the live function's pg_get_functiondef hash (653dd86c, measured
-- 2026-10-15), with three changes:
--   1. the actor's display_name is read from users, within p_org, as the audit
--      trigger reads it, so the Worker's call and the signature are unchanged;
--   2. updated_by_name is set to it, NULL when the user has no name, so the row
--      never keeps naming the previous editor (the footer then falls back to
--      updated_by_email, which is this actor's);
--   3. bidspoke.actor_name carries it too, the setting the audit trigger falls
--      back to.
--
-- Expand only: the same signature replaced in place, so the deployed Worker
-- calls it exactly as before. The grants are restated as in 20260921221007:
-- service_role only, which partner_page_function_grants.test.sql asserts.

CREATE OR REPLACE FUNCTION public.rename_partner_step_namespace(
  p_org uuid,
  p_partner uuid,
  p_columns jsonb,
  p_actor uuid,
  p_actor_email text,
  p_context jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  k text;
  v_n integer;
  v_actor_name text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(p_columns, '{}'::jsonb)) LOOP
    IF k NOT IN ('bid_formula', 'bid_resolver_config') THEN
      RAISE EXCEPTION 'column_not_renameable' USING ERRCODE = 'BP422', DETAIL = k;
    END IF;
  END LOOP;
  -- The renaming user's name as it is now (#2151), from this organization only.
  SELECT nullif(u.display_name, '') INTO v_actor_name FROM users u WHERE u.id = p_actor AND u.organization_id = p_org;
  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.actor_name', coalesce(v_actor_name, ''), true);
  PERFORM set_config('bidspoke.audit_reason', coalesce(p_context->>'reason', 'step_id_renamed'), true);
  PERFORM set_config('bidspoke.audit_context', coalesce(p_context, '{}'::jsonb)::text, true);
  UPDATE partner_configs
  SET bid_formula = CASE WHEN p_columns ? 'bid_formula' THEN p_columns->>'bid_formula' ELSE bid_formula END,
      bid_resolver_config = CASE WHEN p_columns ? 'bid_resolver_config' THEN p_columns->'bid_resolver_config' ELSE bid_resolver_config END,
      updated_by = p_actor,
      updated_by_email = p_actor_email,
      updated_by_name = v_actor_name
  WHERE id = p_partner AND organization_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) IS
  'Rewrite bid_formula and bid_resolver_config on one partner for a step id rename, carrying the actor, reason and context onto the audit row (#1409), and stamping updated_by, updated_by_email and updated_by_name for the renaming user, the name read from users within p_org (#2151). Refuses any other column (BP422 column_not_renameable). Returns rows updated.';
REVOKE ALL ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) TO service_role;
