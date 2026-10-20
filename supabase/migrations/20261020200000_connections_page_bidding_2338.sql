-- The bidding database's half of the Connections page (#2338, build PR 3 of the
-- plan approved 2026-10-20; requirements R5 and R9). EXPAND only.
--
-- 1. service_type widened. The CHECK was a closed list of the four services the
--    money lane had before the ops connections lane existed (salesforce,
--    supabase, snowflake, slack). An ops connection names any service of the
--    catalogue (packages/service-catalogue CATALOGUE, whose keys are also the
--    ops registry's, apps/worker/src/ops/connections/services.ts), and the
--    catalogue grows one service per pull request of #2337. So the list becomes
--    the catalogue's key shape, the same pattern the ops copies table holds
--    (connection_copies_service_check, ops migration 20261017220000), and the
--    catalogue stays the one home of which services exist (L83): the save
--    route refuses a service the catalogue does not declare, and ops refuses
--    one it has not registered (connection_service_unknown). A closed list here
--    would need a bidding migration before every new service could be saved.
-- 2. An ops only service must be an ops_key row. Only the four services above
--    exist on the money lane; every other service exists only on ops, so a row
--    naming one must be sealed to the ops key, never bidding_ring and never
--    unsealed. Written with IS NOT DISTINCT FROM, because a CHECK reads null as
--    a pass and sealed_for is null on an unsealed row.
-- 3. acts_as: who the connection acts as (an integration user, a mailbox, a
--    Snowflake user), read from the service when the login is verified, never
--    typed (R15). Nullable: no row has one yet, and the Slack alert row never
--    will. The table's audit (20261018191000) records it with its value, old
--    and new, because it names an account, not a secret: a conscious choice
--    (L657), and the reason the audit function is not changed here.
-- 4. Four functions, each SECURITY DEFINER with its own search_path, taking the
--    caller's organization (from its verified token, in the route) and refusing
--    a connection of any other as connection_not_found. service_role only.
--    a. connection_references(org, connection): the workflows of the
--       organization whose one current definition (workflows.definition) holds
--       the connection's id, soft deleted ones included (a hand run restore can
--       bring them back) and marked deleted. Snapshots in workflow_versions do
--       not count (decision of 2026-10-01). No node type carries a connection
--       id yet, so no key name can be relied on: a reference is any string in
--       the definition, at any depth and under any key, equal to the id
--       (ignoring case and surrounding space). Never by name. Erring towards a
--       reference is the harmless side (L648): it refuses a removal rather than
--       stranding a step.
--    b. remove_ops_connection(org, connection, actor): locks the row, and while
--       connection_references is non empty answers connection_in_use naming
--       every such workflow (deleted ones marked) and writes nothing; otherwise
--       writes the tombstone at the row's generation and deletes the row in the
--       same transaction, the delete audited under the actor. The row lock is
--       what a workflow writer's re-check (build PR 7) must share: reading the
--       connection rows it names FOR KEY SHARE makes a save and a removal
--       serialise, so neither can pass the other's check.
--    c. reconnect_ops_connection(org, connection, expected generation, new
--       generation, envelope, acts_as, actor, actor email): a compare and set.
--       Writes the new sealed login, generation and acts_as only when the row
--       is still at the expected generation; otherwise writes nothing and
--       answers stale_generation with the row's generation. The route commits
--       this BEFORE ops is told of the new generation (finding F116, build PR
--       6), so ops never holds a generation the declared home did not commit.
--    d. connection_history(org, connection, limit): the connection's audit
--       rows, newest first, with who made each change. credential_enc and
--       bot_token are dropped from every row, key and value, and replaced by
--       one credential_changed flag; a config's bot_token is dropped too, so
--       even a hand written row cannot carry a credential out (L529).
--
-- Additive (CLAUDE.md, ADR 0007): a widened CHECK, a new CHECK every existing
-- row already satisfies (production holds one row, the Slack alert row,
-- bidding_ring, measured 2026-10-19 by 20261019150000), a nullable column and
-- four new functions. No deployed code calls the functions or reads the column
-- yet: the routes come in build PRs 4 to 6. The code running when this is
-- applied, and its rollback target, are unaffected.
--
-- Who can reach what this adds: service_role only, revoked from PUBLIC, anon
-- and authenticated by name (L541). Whose data: the one connection named, and
-- the workflows and audit rows of the organization named.
--
-- Guarded by supabase/tests/connections_page_bidding.test.sql.

SET LOCAL lock_timeout = '5s';

-- ── 1, 2. service_type ───────────────────────────────────────────────────────

ALTER TABLE public.service_connections
  DROP CONSTRAINT IF EXISTS service_connections_service_type_check;
ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_service_type_check
    CHECK (service_type ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_ops_only_services
    CHECK (sealed_for IS NOT DISTINCT FROM 'ops_key' OR service_type IN ('salesforce', 'supabase', 'snowflake', 'slack'));

COMMENT ON COLUMN public.service_connections.service_type IS
  'The service, by its catalogue key (packages/service-catalogue, #2338). Any key of the catalogue''s shape; only salesforce, supabase, snowflake and slack may be a row not sealed to the ops key (service_connections_ops_only_services), since every other service exists only on the ops lane.';

-- ── 3. acts_as ───────────────────────────────────────────────────────────────

ALTER TABLE public.service_connections
  ADD COLUMN IF NOT EXISTS acts_as text NULL;

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_acts_as_shape
    CHECK (acts_as IS NULL OR (btrim(acts_as) <> '' AND char_length(acts_as) <= 320));

COMMENT ON COLUMN public.service_connections.acts_as IS
  'Who the connection acts as (an integration user, a mailbox, a Snowflake user), read from the service when its login is verified, never typed (#2338, R15). Null until a verify has read it, and on the Slack alert row. Not a secret: the audit records its values.';

-- ── 4a. connection_references ────────────────────────────────────────────────

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

  -- Every workflow of the organization, deleted ones too. strict, so .** visits
  -- each value once (lax mode unwraps arrays and repeats them).
  RETURN QUERY
    SELECT w.id, w.name, w.deleted_at IS NOT NULL
    FROM public.workflows w
    WHERE w.organization_id = p_organization_id
      AND EXISTS (
        SELECT 1
        FROM jsonb_path_query(w.definition, 'strict $.**') v
        WHERE jsonb_typeof(v) = 'string'
          AND lower(btrim(v #>> '{}')) = p_connection_id::text
      )
    ORDER BY w.deleted_at IS NOT NULL, w.name, w.id;
END
$$;

REVOKE ALL ON FUNCTION public.connection_references(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connection_references(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.connection_references(uuid, uuid) IS
  'The workflows of the named organization whose current definition holds the connection''s id, as any string at any depth, soft deleted ones included and marked (#2338, R5, R9). Never by name, never workflow_versions. Raises connection_not_found for a connection not in the organization. service_role only.';

-- ── 4b. remove_ops_connection ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.remove_ops_connection(p_organization_id uuid, p_connection_id uuid, p_actor uuid)
RETURNS TABLE (outcome text, removed_generation bigint, workflows jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_sealed_for text;
  v_generation bigint;
  v_using jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'remove_refused: the actor is required' USING ERRCODE = '22023';
  END IF;

  SELECT sc.sealed_for, sc.credential_generation INTO v_sealed_for, v_generation
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sealed_for IS DISTINCT FROM 'ops_key' THEN
    -- The Slack alert row is removed by the Slack Disconnect, never here.
    RAISE EXCEPTION 'connection_not_ops_key' USING ERRCODE = 'BP422';
  END IF;

  -- The one predicate the Used by tab also reads.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.workflow_id, 'name', r.name, 'deleted', r.deleted)
                            ORDER BY r.deleted, r.name, r.workflow_id), '[]'::jsonb)
  INTO v_using
  FROM public.connection_references(p_organization_id, p_connection_id) r;
  IF v_using <> '[]'::jsonb THEN
    RETURN QUERY SELECT 'connection_in_use'::text, NULL::bigint, v_using;
    RETURN;
  END IF;

  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES (p_organization_id, p_connection_id, v_generation);

  -- Transaction local, set for this one DELETE and cleared straight after, so
  -- the audit names this removal's actor and nothing after it.
  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  DELETE FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id;
  PERFORM set_config('bidspoke.actor_id', '', true);

  RETURN QUERY SELECT 'removed'::text, v_generation, '[]'::jsonb;
END
$$;

REVOKE ALL ON FUNCTION public.remove_ops_connection(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_ops_connection(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.remove_ops_connection(uuid, uuid, uuid) IS
  'Removes one ops connection of the named organization (#2338, R9, R21): answers connection_in_use with every workflow using it (deleted ones marked) and writes nothing, or writes the tombstone at the row''s generation and deletes the row in one transaction, audited under the actor, and answers removed. Raises connection_not_found (not the organization''s) or connection_not_ops_key (the Slack alert row). service_role only.';

-- ── 4c. reconnect_ops_connection ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reconnect_ops_connection(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_generation bigint,
  p_new_generation bigint,
  p_envelope jsonb,
  p_acts_as text,
  p_actor uuid,
  p_actor_email text
)
RETURNS TABLE (outcome text, current_generation bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_sealed_for text;
  v_generation bigint;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'reconnect_refused: the actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 1 THEN
    RAISE EXCEPTION 'reconnect_refused: the expected generation is below 1' USING ERRCODE = '22023';
  END IF;
  IF p_new_generation IS NULL OR p_new_generation <= p_expected_generation THEN
    RAISE EXCEPTION 'reconnect_refused: the new generation is not above the expected one' USING ERRCODE = '22023';
  END IF;
  -- The seal's envelope and nothing else, as replace_connection_envelope and the ops copy's CHECK hold it.
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR NOT (p_envelope ?& ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'])
     OR p_envelope - ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'] <> '{}'::jsonb
     OR p_envelope -> 'v' <> '1'::jsonb
     OR jsonb_typeof(p_envelope -> 'kid') <> 'string' OR jsonb_typeof(p_envelope -> 'wrapped_key') <> 'string'
     OR jsonb_typeof(p_envelope -> 'iv') <> 'string' OR jsonb_typeof(p_envelope -> 'ct') <> 'string'
     OR p_envelope ->> 'kid' !~ '^[a-z0-9][a-z0-9-]{0,62}$'
     OR p_envelope ->> 'iv' = '' OR p_envelope ->> 'ct' = ''
     OR octet_length(p_envelope::text) > 65536 THEN
    RAISE EXCEPTION 'reconnect_refused: the envelope is not of the seal''s shape' USING ERRCODE = '22023';
  END IF;

  SELECT sc.sealed_for, sc.credential_generation INTO v_sealed_for, v_generation
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sealed_for IS DISTINCT FROM 'ops_key' THEN
    RAISE EXCEPTION 'connection_not_ops_key' USING ERRCODE = 'BP422';
  END IF;
  IF v_generation <> p_expected_generation THEN
    RETURN QUERY SELECT 'stale_generation'::text, v_generation;
    RETURN;
  END IF;

  -- updated_by names the actor for the audit (service_connections_capture_actor).
  UPDATE public.service_connections sc
  SET credential_enc = p_envelope::text,
      credential_generation = p_new_generation,
      acts_as = p_acts_as,
      updated_by = p_actor,
      updated_by_email = p_actor_email,
      updated_at = now()
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id;

  RETURN QUERY SELECT 'reconnected'::text, p_new_generation;
END
$$;

REVOKE ALL ON FUNCTION public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text) IS
  'Compare and set of an ops connection''s new login (#2338, R19): writes credential_enc, credential_generation and acts_as only when the named organization''s ops_key row is still at the expected generation, audited under the actor, and answers reconnected; otherwise writes nothing and answers stale_generation with the row''s generation. Raises connection_not_found or connection_not_ops_key, and refuses a malformed call by name (reconnect_refused). service_role only.';

-- ── 4d. connection_history ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.connection_history(p_organization_id uuid, p_connection_id uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (
  audit_id uuid,
  action text,
  changed_at timestamptz,
  changed_by uuid,
  changed_by_name text,
  changed_by_email text,
  changes jsonb,
  credential_changed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'connection_history_refused: the limit must be from 1 to 500' USING ERRCODE = '22023';
  END IF;
  IF p_organization_id IS NULL OR p_connection_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.service_connections sc
                    WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
    SELECT
      a.id,
      a.action,
      a.changed_at,
      a.changed_by,
      u.display_name,
      u.email,
      CASE
        WHEN jsonb_typeof(a.changes) <> 'object' THEN a.changes
        WHEN jsonb_typeof(a.changes -> 'config') = 'object' THEN
          (a.changes - 'credential_enc' - 'bot_token') || jsonb_build_object('config',
            CASE
              WHEN (a.changes -> 'config') ?| ARRAY['old', 'new'] THEN
                (a.changes -> 'config')
                  || CASE WHEN jsonb_typeof(a.changes #> '{config,old}') = 'object'
                          THEN jsonb_build_object('old', (a.changes #> '{config,old}') - 'bot_token') ELSE '{}'::jsonb END
                  || CASE WHEN jsonb_typeof(a.changes #> '{config,new}') = 'object'
                          THEN jsonb_build_object('new', (a.changes #> '{config,new}') - 'bot_token') ELSE '{}'::jsonb END
              ELSE (a.changes -> 'config') - 'bot_token'
            END)
        ELSE a.changes - 'credential_enc' - 'bot_token'
      END,
      coalesce(jsonb_typeof(a.changes) = 'object' AND a.changes ?| ARRAY['credential_enc', 'bot_token'], false)
    FROM public.audit_log a
    LEFT JOIN public.users u ON u.id = a.changed_by
    WHERE a.organization_id = p_organization_id
      AND a.entity_type = 'service_connection'
      AND a.entity_id = p_connection_id
    ORDER BY a.changed_at DESC, a.id DESC
    LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION public.connection_history(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connection_history(uuid, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.connection_history(uuid, uuid, integer) IS
  'The audit rows of one connection of the named organization, newest first, with who made each change (#2338, R5, the History tab). credential_enc and bot_token are dropped from every row, key and value, and replaced by credential_changed. Raises connection_not_found for a connection not in the organization. Read only. service_role only.';
