-- An ops workflow version keeps the environment variables its definition names,
-- as they are when the version is written (#2702). EXPAND only.
--
-- Dan's decisions of 2026-10-28 on #2702: an ops run's plain variables are
-- frozen with the workflow version, as the definition is, so a run uses what
-- was saved, a change takes effect at the next save, and a run never needs the
-- bidding database to read them; and an ops run never receives a secret
-- variable (a credential belongs in a connection), so only a secret's name is
-- kept, for the run to refuse it by name.
--
-- What this adds:
-- 1. workflow_versions.env_capture, nullable: for a version of an ops lane
--    workflow, every saved environment_variables row its runs could read
--    whose name the definition mentions, each as {key, value, is_secret,
--    scope, workflow_id}, in the order they were saved (created_at, then id,
--    the env loader's order), with a secret's value left out. Null for a money
--    lane version and for every version written before this.
-- 2. The trigger capture_version_env_variables, BEFORE INSERT on
--    workflow_versions, which writes it. A trigger rather than write_workflow,
--    so every op that writes a version (create, duplicate, save, restore) and
--    any later writer keeps it, and a writer cannot name a capture of its own:
--    whatever it names is replaced by what the database reads. A version is
--    never updated (service_role holds UPDATE on commit_sha alone), so the
--    capture is fixed once written.
--
-- WHAT IS KEPT, AND WHY THIS WIDELY. A row reaches a workflow's runs when it is
-- the organization's (scope global) or saved for that workflow (scope
-- workflow); the finer rules (which of two wins, the organization only keys)
-- are the env loader's rowReach, applied by the Worker when it serves the
-- version (lib/version-variables.ts), so they live in one place. A name counts
-- as mentioned wherever env.NAME appears in the definition's text, a superset
-- of what the definition actually reads (envReferences, which requires a path
-- or a template), so nothing it reads is ever left out; the Worker serves to
-- ops only the variables it reads. An empty value is no value, as the env
-- loader skips it.
--
-- WHO CAN READ IT. Members of the organization, through the versions_org
-- policy, who can already read the same rows in environment_variables; a
-- secret's value is never copied. service_role writes versions only through
-- write_workflow (SECURITY DEFINER), so the trigger reads as that function's
-- owner.
--
-- Expand only (ADR 0007): a nullable column with no default (no rewrite) and a
-- trigger that writes only that column. Code deployed before this never names
-- the column, and a version it saves gains a capture it ignores. This MUST be
-- applied BEFORE the Worker that serves it deploys: that Worker selects
-- env_capture when serving an ops version's definition, and the select fails
-- while the column is missing.
--
-- Guarded by supabase/tests/version_env_capture.test.sql.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.workflow_versions
  ADD COLUMN IF NOT EXISTS env_capture jsonb NULL
  CONSTRAINT workflow_versions_env_capture_is_list CHECK (env_capture IS NULL OR jsonb_typeof(env_capture) = 'array');

COMMENT ON COLUMN public.workflow_versions.env_capture IS
  'For a version of an ops lane workflow, the environment_variables rows its runs could read whose name the definition mentions, as they were when the version was written: {key, value, is_secret, scope, workflow_id}, in saved order, a secret''s value null (#2702). Written by the capture_version_env_variables trigger alone. Null for a money lane version and every version written before #2702.';

CREATE OR REPLACE FUNCTION public.capture_version_env_variables()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_lane text;
  v_org uuid;
  v_names text[];
BEGIN
  SELECT w.lane, w.organization_id INTO v_lane, v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  IF v_lane IS DISTINCT FROM 'ops' THEN
    NEW.env_capture := NULL;
    RETURN NEW;
  END IF;

  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO v_names
  FROM regexp_matches(coalesce(NEW.definition::text, ''), 'env\.([A-Za-z0-9_]+)', 'g') AS m;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', e.key,
           'value', CASE WHEN e.is_secret THEN NULL ELSE e.value END,
           'is_secret', e.is_secret,
           'scope', e.scope,
           'workflow_id', e.workflow_id)
         ORDER BY e.created_at, e.id), '[]'::jsonb)
  INTO NEW.env_capture
  FROM public.environment_variables e
  WHERE e.organization_id = v_org
    AND e.key = ANY (v_names)
    AND e.value IS NOT NULL AND e.value <> ''
    AND (e.scope = 'global' OR (e.scope = 'workflow' AND e.workflow_id = NEW.workflow_id));
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.capture_version_env_variables() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.capture_version_env_variables() IS
  'BEFORE INSERT on workflow_versions (#2702): for an ops lane workflow, sets env_capture to the environment_variables rows its runs could read whose name the definition mentions, in saved order, a secret''s value left out; null for any other lane. Replaces whatever the writer named, so the capture is always the database''s own reading.';

DROP TRIGGER IF EXISTS capture_version_env_variables ON public.workflow_versions;
CREATE TRIGGER capture_version_env_variables
  BEFORE INSERT ON public.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION public.capture_version_env_variables();
