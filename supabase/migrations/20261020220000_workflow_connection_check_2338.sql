-- Workflow writers re-check connection ids (#2338, build PR 7 of the plan
-- approved 2026-10-20; R9). EXPAND only.
--
-- A workflow definition may name a connection only by its id, and a removed
-- connection's id must not come back into a definition: a step naming it would
-- fail on every run with connection_removed. remove_ops_connection (migration
-- 20261020200000) refuses while a definition names the connection; this is the
-- other side, so a definition cannot come to name one after it is gone.
--
-- 1. definition_connection_ids(definition): every string of the definition, at
--    any depth and under any key, that could be a connection id, ignoring case
--    and surrounding spaces, once each. The ONE predicate (L342, L370):
--    connection_references is redefined on it below with the same signature
--    and the same answers, and the check reads it, so what counts as a
--    reference when a connection is removed and what counts when a workflow is
--    saved cannot drift apart. The old rule compared lower(btrim(string)) with
--    the id's text; a string equals some uuid's text exactly when it has the
--    canonical shape, so this set holds exactly the strings that rule could
--    match. No node type carries a connection id yet, so no key name is relied
--    on (the same reason as connection_references).
-- 2. definition_connection_problems(org, definition): each such id that is not
--    a live connection of the organization but is a connection somewhere:
--      removed                a tombstone of the organization and no live row,
--                             with the connection's name as its removal's
--                             audit row recorded it (null when none survives);
--      not_this_organization  a live row or a tombstone of another
--                             organization. Never named: a name of another
--                             organization's connection is not this one's to
--                             read.
--    Each with the steps (node namespaces) whose own JSON holds the id, by the
--    same predicate. An id that is no connection anywhere (a node's id, a
--    partner's) is not a problem: nothing can tell it from any other uuid.
--    STABLE, read only, service_role only: the save routes call it before they
--    write, so they can refuse by name and write nothing.
-- 3. The guarantee is the trigger, not the routes. workflows_refuse_missing_
--    connections runs BEFORE INSERT and BEFORE an UPDATE OF definition or
--    organization_id, in the writer's own transaction, whoever the writer is (a
--    route, a hand run SQL restore, a future writer; L593). It first reads the
--    organization's live connection rows the definition names FOR KEY SHARE,
--    then judges the definition with definition_connection_problems in a
--    statement that starts after that lock. remove_ops_connection reads its row
--    FOR UPDATE, which conflicts with FOR KEY SHARE, so:
--      a save that got there first holds the row, the removal waits for it to
--        commit, and then finds the saved definition and answers
--        connection_in_use;
--      a removal that got there first makes the save's lock wait; once it
--        commits the row is gone, the lock reads nothing, and the judging
--        statement sees the tombstone and refuses the save.
--    Neither can pass the other's check (the migration header of PR 3 asked
--    for exactly this). The refusal is SQLSTATE BP409 with the message
--    workflow_names_missing_connection and the problems as JSON in its DETAIL,
--    so a route that lost the race still answers by name.
--    An UPDATE leaving the definition as it was is not judged, so renaming or
--    moving a workflow is never refused by this; a definition that changes is
--    judged whole, so a save must replace every removed connection it names.
--
-- Additive (CLAUDE.md, ADR 0007): two new functions, a redefined function with
-- the same signature and answers, and a trigger. The code running when this is
-- applied keeps working: it never names a connection id (no node type carries
-- one), so the trigger refuses none of its writes; a write that did name a
-- removed connection would be refused, which is the point, and the old code
-- answers it as its generic error. Existing rows are not judged: the trigger
-- runs on writes only. The new routes (this pull request) call
-- definition_connection_problems first; until this is applied they find it
-- missing and refuse every definition write by name rather than saving
-- unchecked, which is why this is applied before that code deploys.
--
-- Who can reach what this adds: service_role only, revoked from PUBLIC, anon
-- and authenticated by name (L541). Whose data: the connections, tombstones
-- and removal audit rows of the organization named, and of another
-- organization only whether an id is one of its connections, never its name.
--
-- Guarded by supabase/tests/workflow_connection_check.test.sql.

SET LOCAL lock_timeout = '5s';

-- ── 1. definition_connection_ids ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.definition_connection_ids(p_definition jsonb)
RETURNS SETOF uuid
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- strict, so .** visits each value once (lax mode unwraps arrays and repeats them).
  SELECT DISTINCT s.v::uuid
  FROM (
    SELECT lower(btrim(x #>> '{}')) AS v
    FROM jsonb_path_query(p_definition, 'strict $.**') x
    WHERE jsonb_typeof(x) = 'string'
  ) s
  WHERE s.v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

REVOKE ALL ON FUNCTION public.definition_connection_ids(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.definition_connection_ids(jsonb) TO service_role;

COMMENT ON FUNCTION public.definition_connection_ids(jsonb) IS
  'Every string of a workflow definition, at any depth and under any key, that could be a connection id, ignoring case and surrounding spaces, once each (#2338). The one predicate connection_references and the workflow write check both read. service_role only.';

-- ── connection_references, on the one predicate ──────────────────────────────

CREATE OR REPLACE FUNCTION public.connection_references(p_organization_id uuid, p_connection_id uuid)
RETURNS TABLE (workflow_id uuid, name text, deleted boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.service_connections sc
                    WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Every workflow of the organization, deleted ones too.
  RETURN QUERY
    SELECT w.id, w.name, w.deleted_at IS NOT NULL
    FROM public.workflows w
    WHERE w.organization_id = p_organization_id
      AND EXISTS (SELECT 1 FROM public.definition_connection_ids(w.definition) i WHERE i = p_connection_id)
    ORDER BY w.deleted_at IS NOT NULL, w.name, w.id;
END
$$;

-- ── 2. definition_connection_problems ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.definition_connection_problems(p_organization_id uuid, p_definition jsonb)
RETURNS TABLE (connection_id uuid, problem text, name text, steps text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'connection_check_refused: the organization is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH named AS (
      SELECT i AS id FROM public.definition_connection_ids(p_definition) i
    ),
    judged AS (
      SELECT n.id,
        CASE
          WHEN EXISTS (SELECT 1 FROM public.service_connections sc WHERE sc.id = n.id AND sc.organization_id = p_organization_id) THEN NULL
          WHEN EXISTS (SELECT 1 FROM public.service_connections sc WHERE sc.id = n.id) THEN 'not_this_organization'
          WHEN EXISTS (SELECT 1 FROM public.connection_tombstones t WHERE t.connection_id = n.id AND t.organization_id = p_organization_id) THEN 'removed'
          WHEN EXISTS (SELECT 1 FROM public.connection_tombstones t WHERE t.connection_id = n.id) THEN 'not_this_organization'
        END AS problem
      FROM named n
    )
    SELECT
      j.id,
      j.problem,
      CASE WHEN j.problem = 'removed' THEN (
        SELECT a.changes #>> '{name,old}'
        FROM public.audit_log a
        WHERE a.entity_type = 'service_connection' AND a.entity_id = j.id
          AND a.organization_id = p_organization_id AND a.action = 'deleted'
        ORDER BY a.changed_at DESC
        LIMIT 1
      ) END,
      coalesce((
        SELECT array_agg(DISTINCT node ->> 'namespace' ORDER BY node ->> 'namespace')
        FROM jsonb_path_query(p_definition, 'lax $.nodes[*]') node
        WHERE jsonb_typeof(node) = 'object' AND jsonb_typeof(node -> 'namespace') = 'string'
          AND EXISTS (SELECT 1 FROM public.definition_connection_ids(node) k WHERE k = j.id)
      ), ARRAY[]::text[])
    FROM judged j
    WHERE j.problem IS NOT NULL
    ORDER BY j.id;
END
$$;

REVOKE ALL ON FUNCTION public.definition_connection_problems(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.definition_connection_problems(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.definition_connection_problems(uuid, jsonb) IS
  'The connection ids a workflow definition names that are not live connections of the named organization (#2338, R9): removed (a tombstone of the organization, with the name its removal recorded) or not_this_organization (never named), each with the steps naming it. An id that is no connection anywhere is not judged. Read only, service_role only; the workflows trigger enforces the same answer at every write.';

-- ── 3. The trigger ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflows_refuse_missing_connections()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_problems jsonb;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.definition IS NOT DISTINCT FROM OLD.definition
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  -- Hold every live connection of the organization the definition names, so a
  -- removal of one waits for this write (remove_ops_connection reads FOR UPDATE).
  PERFORM 1
  FROM public.service_connections sc
  WHERE sc.organization_id = NEW.organization_id
    AND sc.id IN (SELECT i FROM public.definition_connection_ids(NEW.definition) i)
  ORDER BY sc.id
  FOR KEY SHARE OF sc;

  -- A new statement, so it sees a removal the lock above waited for.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.connection_id, 'problem', p.problem, 'name', p.name, 'steps', to_jsonb(p.steps))
                            ORDER BY p.connection_id), '[]'::jsonb)
  INTO v_problems
  FROM public.definition_connection_problems(NEW.organization_id, NEW.definition) p;

  IF v_problems <> '[]'::jsonb THEN
    RAISE EXCEPTION 'workflow_names_missing_connection'
      USING ERRCODE = 'BP409',
            DETAIL = v_problems::text,
            HINT = 'Give each step named a replacement connection, then save again.';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.workflows_refuse_missing_connections() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.workflows_refuse_missing_connections() IS
  'Refuses a workflow insert, or an update that changes the definition or the organization, whose definition names a connection that is not a live one of its organization (#2338, R9): BP409 workflow_names_missing_connection with the problems as JSON in DETAIL. Holds the named live connections FOR KEY SHARE first, so a save and a removal of one of them cannot pass each other''s check.';

DROP TRIGGER IF EXISTS workflows_refuse_missing_connections ON public.workflows;
CREATE TRIGGER workflows_refuse_missing_connections
  BEFORE INSERT OR UPDATE OF definition, organization_id ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.workflows_refuse_missing_connections();
