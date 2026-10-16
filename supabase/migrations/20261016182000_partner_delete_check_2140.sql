-- A partner delete that knows up front (#2140, PM-13, part of #2114).
--
-- The partners page used to offer Delete and learn at the press that sales
-- still referred to the partner. It now asks first, and the consequence the
-- person reviewed is the one that runs.
--
-- 1. partner_delete_dependents(): every table a partner delete touches or is
--    refused by, read from pg_constraint (L679), never a list: each foreign key
--    to partner_configs, followed recursively through the ON DELETE CASCADE
--    ones, plus partner_uuid_map, keyed by (org_id, partner_slug) with no
--    foreign key, which the delete removes itself. Each row carries the query
--    that selects that table's rows for one partner ($1 the organization, $2 the
--    partner), so the check and the delete count from one definition.
-- 2. partner_delete_counts(p_org, p_id, p_lock): the row count per dependent
--    table, and how many of them block the delete (a RESTRICT or NO ACTION key).
--    With p_lock the rows the delete removes are locked FOR UPDATE as they are
--    counted, so nothing is added beneath them between the count and the delete.
-- 3. partner_delete_check(p_org, p_id): STABLE, service role only. The partner,
--    its dependents with their counts, and how many other partners name its
--    Worker secret. The Worker adds the workflows and the buyer ledger.
-- 4. delete_partner_config(p_org, p_id, p_actor, p_actor_email, p_expected):
--    a new overload. Refuses BP023 while anything blocks, then BP024 when the
--    consequence differs from p_expected (the per table counts and the
--    (id, updated_at) set of the organization's workflows, read FOR SHARE), then
--    deletes the partner and its sub-account IDs in one transaction.
-- 5. delete_partner_config(p_org, p_id, p_actor, p_actor_email): replaced with
--    its signature kept, so the release before keeps working. It also deletes
--    the sub-account IDs now (decision 4). Replaced from 20260921221007, which
--    is the body production runs (prosrc md5 5ef9428022fb3aaa610ca54fc95b8219 on
--    production equals the replayed migration's, read 2026-10-16).
-- 6. change_partner_uuid: the add takes FOR KEY SHARE on the partner row, so an
--    add racing a delete waits for it and then finds no partner, instead of
--    leaving a mapping to a slug that no longer exists. Replaced from
--    20261016170000 (prosrc md5 f284f97d97477cd0a130670cd92eb7cf on production
--    equals the replayed migration's, read 2026-10-16); only the add's check
--    changed.
--
-- The partner row goes before its sub-account IDs, so the partner_uuid_map
-- notice trigger finds no partner for them and the page hears one notice for
-- the delete, as it did before.
--
-- Expand only (docs/adr/0007): three new functions and an overload; the two
-- replaced functions keep their signatures. The four argument delete is the
-- contract half's to drop once no release calls it.

-- ── 1. partner_delete_dependents ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.partner_delete_dependents()
RETURNS TABLE (table_name text, reached_by text, on_delete text, depth integer, row_query text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH RECURSIVE edges AS (
    -- Foreign keys declared on parent tables only: a partition carries a copy of
    -- its parent's key (conparentid set), which the parent's row already covers.
    SELECT
      k.conname::text AS conname,
      k.conrelid,
      k.confrelid,
      CASE k.confdeltype WHEN 'c' THEN 'cascade' WHEN 'r' THEN 'restrict' WHEN 'a' THEN 'no action' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS on_delete,
      (SELECT string_agg(format('d.%I', a.attname), ', ' ORDER BY u.ord)
         FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS child_cols,
      (SELECT string_agg(format('p.%I', a.attname), ', ' ORDER BY u.ord)
         FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS parent_cols
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    WHERE k.contype = 'f' AND k.conparentid = 0 AND NOT c.relispartition
  ),
  walk AS (
    SELECT
      e.conrelid AS rel,
      e.conname AS reached_by,
      e.on_delete,
      1 AS depth,
      format('SELECT d.tableoid AS dep_tableoid, d.ctid AS dep_ctid, d.* FROM %s d WHERE (%s) IN (SELECT %s FROM public.partner_configs p WHERE p.id = $2 AND p.organization_id = $1)',
        e.conrelid::regclass, e.child_cols, e.parent_cols) AS row_query,
      ARRAY[e.conrelid] AS path
    FROM edges e
    WHERE e.confrelid = 'public.partner_configs'::regclass
    UNION ALL
    -- The sub-account IDs: keyed by the partner's slug in its organization, with
    -- no foreign key, so the delete removes them itself.
    SELECT
      'public.partner_uuid_map'::regclass::oid,
      'partner_slug',
      'deleted by the function',
      1,
      'SELECT d.tableoid AS dep_tableoid, d.ctid AS dep_ctid, d.* FROM public.partner_uuid_map d WHERE d.org_id = $1 AND d.partner_slug = (SELECT p.slug FROM public.partner_configs p WHERE p.id = $2 AND p.organization_id = $1)',
      ARRAY['public.partner_uuid_map'::regclass::oid]
    UNION ALL
    SELECT
      e.conrelid,
      e.conname,
      e.on_delete,
      w.depth + 1,
      format('SELECT d.tableoid AS dep_tableoid, d.ctid AS dep_ctid, d.* FROM %s d WHERE (%s) IN (SELECT %s FROM (%s) p)', e.conrelid::regclass, e.child_cols, e.parent_cols, w.row_query),
      w.path || e.conrelid
    FROM walk w
    JOIN edges e ON e.confrelid = w.rel
    -- Only a removed row's children are reached: a blocking or cleared key ends
    -- the walk, and a table already on this path ends it too.
    WHERE w.on_delete IN ('cascade', 'deleted by the function')
      AND NOT e.conrelid = ANY (w.path)
      AND w.depth < 10
  )
  SELECT c.relname::text, w.reached_by, w.on_delete, w.depth, w.row_query
  FROM walk w
  JOIN pg_class c ON c.oid = w.rel
  ORDER BY w.depth, c.relname, w.reached_by
$$;
COMMENT ON FUNCTION public.partner_delete_dependents() IS
  'Every table a partner delete touches or is refused by (#2140): each foreign key to partner_configs from pg_constraint, followed recursively through the cascading ones, plus partner_uuid_map by slug. row_query selects one partner''s rows of that table ($1 organization, $2 partner). Read by partner_delete_counts, so the check and the delete share it. Internal.';
REVOKE ALL ON FUNCTION public.partner_delete_dependents() FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. partner_delete_counts ─────────────────────────────────────────────────
-- One row per dependent table. kind: blocks (a RESTRICT or NO ACTION key; its
-- rows refuse the delete), deleted (removed with the partner), or cleared (a SET
-- NULL or SET DEFAULT key; the row stays and loses its link). A table reached by
-- more than one key is counted once per row (its tableoid and ctid, which
-- each row_query carries as dep_tableoid and dep_ctid), and blocks when
-- any of its keys does; blocking_rows counts only the rows a blocking key holds.
CREATE OR REPLACE FUNCTION public.partner_delete_counts(p_org uuid, p_id uuid, p_lock boolean)
RETURNS TABLE (table_name text, kind text, row_count bigint, blocking_rows bigint, depth integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t record;
  v_all text;
  v_blocking text;
BEGIN
  FOR t IN
    SELECT d.table_name,
           min(d.depth) AS depth,
           bool_or(d.on_delete IN ('restrict', 'no action')) AS blocks,
           bool_or(d.on_delete IN ('set null', 'set default')) AS clears,
           array_agg(d.row_query) AS queries,
           array_agg(d.row_query) FILTER (WHERE d.on_delete IN ('restrict', 'no action')) AS blocking_queries,
           bool_and(d.on_delete IN ('cascade', 'deleted by the function')) AS removed
    FROM public.partner_delete_dependents() d
    GROUP BY d.table_name
    ORDER BY min(d.depth), d.table_name
  LOOP
    SELECT string_agg(format('SELECT q.dep_tableoid, q.dep_ctid FROM (%s%s) q', x, CASE WHEN p_lock AND t.removed THEN ' FOR UPDATE OF d' ELSE '' END), ' UNION ')
      INTO v_all FROM unnest(t.queries) x;
    table_name := t.table_name;
    depth := t.depth;
    kind := CASE WHEN t.blocks THEN 'blocks' WHEN t.clears THEN 'cleared' ELSE 'deleted' END;
    EXECUTE format('SELECT count(*) FROM (%s) r', v_all) INTO row_count USING p_org, p_id;
    IF t.blocks THEN
      SELECT string_agg(format('SELECT q.dep_tableoid, q.dep_ctid FROM (%s) q', x), ' UNION ') INTO v_blocking FROM unnest(t.blocking_queries) x;
      EXECUTE format('SELECT count(*) FROM (%s) r', v_blocking) INTO blocking_rows USING p_org, p_id;
    ELSE
      blocking_rows := 0;
    END IF;
    RETURN NEXT;
  END LOOP;
END
$$;
COMMENT ON FUNCTION public.partner_delete_counts(uuid, uuid, boolean) IS
  'One partner''s rows per table partner_delete_dependents() names (#2140), with the kind (blocks, deleted, cleared) and the rows that block. p_lock locks the rows the delete removes FOR UPDATE as it counts them. Internal: called by partner_delete_check and delete_partner_config.';
REVOKE ALL ON FUNCTION public.partner_delete_counts(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. partner_delete_check ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.partner_delete_check(p_org uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_partner record;
  v_dependents jsonb;
  v_secret jsonb;
BEGIN
  SELECT id, name, slug, partner_type, is_active, cf_secret_key INTO v_partner
  FROM partner_configs WHERE id = p_id AND organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('table', c.table_name, 'kind', c.kind, 'rows', c.row_count, 'blocking_rows', c.blocking_rows) ORDER BY c.depth, c.table_name), '[]'::jsonb)
    INTO v_dependents
  FROM public.partner_delete_counts(p_org, p_id, false) c;

  -- The Worker secret is one binding for every organization, so every other
  -- partner naming it is counted, in any organization. Only the count leaves.
  IF nullif(v_partner.cf_secret_key, '') IS NOT NULL THEN
    v_secret := jsonb_build_object(
      'name', v_partner.cf_secret_key,
      'other_partners', (SELECT count(*) FROM partner_configs o WHERE o.cf_secret_key = v_partner.cf_secret_key AND o.id <> p_id)
    );
  END IF;

  RETURN jsonb_build_object(
    'partner', jsonb_build_object('id', v_partner.id, 'name', v_partner.name, 'slug', v_partner.slug, 'partner_type', v_partner.partner_type, 'is_active', v_partner.is_active),
    'dependents', v_dependents,
    'secret', v_secret
  );
END
$$;
COMMENT ON FUNCTION public.partner_delete_check(uuid, uuid) IS
  'What deleting one partner would do (#2140): the partner, each table partner_delete_dependents() names with its rows and blocking rows, and how many other partners name its Worker secret. STABLE, read only. Refuses partner_not_found (P0002). Service role only.';
REVOKE ALL ON FUNCTION public.partner_delete_check(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_delete_check(uuid, uuid) TO service_role;

-- ── 4. The one body of both deletes ──────────────────────────────────────────
-- Locks the partner, refuses on blockers (BP023), compares the consequence when
-- one is given (BP024), then deletes the partner and its sub-account IDs.
CREATE OR REPLACE FUNCTION public._delete_partner_config(p_org uuid, p_id uuid, p_actor uuid, p_actor_email text, p_expected jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_slug text;
  v_detail text;
  v_table text;
  v_now jsonb;
  v_counts jsonb;
  v_blocking text;
  v_workflows_differ boolean;
BEGIN
  IF p_expected IS NOT NULL AND (jsonb_typeof(p_expected -> 'counts') IS DISTINCT FROM 'object' OR jsonb_typeof(p_expected -> 'workflows') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'expected_consequence_invalid' USING ERRCODE = 'BP422', DETAIL = 'expected must carry counts (an object) and workflows (an array)';
  END IF;

  -- The partner row first: every key to it takes FOR KEY SHARE on it, so no new
  -- dependent row can arrive while this transaction holds it.
  SELECT slug INTO v_slug FROM partner_configs WHERE id = p_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The workflows the reviewed consequence was read from, held until commit.
  IF p_expected IS NOT NULL THEN
    PERFORM 1 FROM workflows WHERE organization_id = p_org AND deleted_at IS NULL FOR SHARE;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('table', c.table_name, 'rows', c.row_count, 'blocking_rows', c.blocking_rows)), '[]'::jsonb) INTO v_now
  FROM public.partner_delete_counts(p_org, p_id, true) c;

  SELECT string_agg(format('%s rows in %s', n ->> 'blocking_rows', n ->> 'table'), ', ' ORDER BY n ->> 'table') INTO v_blocking
  FROM jsonb_array_elements(v_now) n WHERE (n ->> 'blocking_rows')::bigint > 0;
  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION 'partner_has_dependents' USING ERRCODE = 'BP023', DETAIL = v_blocking;
  END IF;

  IF p_expected IS NOT NULL THEN
    SELECT coalesce(jsonb_object_agg(n ->> 'table', (n ->> 'rows')::bigint), '{}'::jsonb) INTO v_counts FROM jsonb_array_elements(v_now) n;
    BEGIN
      SELECT EXISTS (
        (SELECT w.id, w.updated_at FROM workflows w WHERE w.organization_id = p_org AND w.deleted_at IS NULL
         EXCEPT
         SELECT (e ->> 'id')::uuid, (e ->> 'updated_at')::timestamptz FROM jsonb_array_elements(p_expected -> 'workflows') e)
        UNION ALL
        (SELECT (e ->> 'id')::uuid, (e ->> 'updated_at')::timestamptz FROM jsonb_array_elements(p_expected -> 'workflows') e
         EXCEPT
         SELECT w.id, w.updated_at FROM workflows w WHERE w.organization_id = p_org AND w.deleted_at IS NULL)
      ) INTO v_workflows_differ;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR wrong_object_type OR invalid_parameter_value THEN
      RAISE EXCEPTION 'expected_consequence_invalid' USING ERRCODE = 'BP422', DETAIL = 'each expected workflow must carry an id and an updated_at';
    END;
    IF v_counts IS DISTINCT FROM p_expected -> 'counts' THEN
      RAISE EXCEPTION 'partner_delete_consequence_changed' USING ERRCODE = 'BP024', DETAIL = 'counts';
    END IF;
    IF v_workflows_differ THEN
      RAISE EXCEPTION 'partner_delete_consequence_changed' USING ERRCODE = 'BP024', DETAIL = 'workflows';
    END IF;
  END IF;

  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.audit_handled', 'delete_partner_config', true);
  BEGIN
    DELETE FROM partner_configs WHERE id = p_id AND organization_id = p_org;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_table = TABLE_NAME;
    RAISE EXCEPTION 'partner_has_dependents' USING ERRCODE = 'BP023', DETAIL = coalesce(v_detail, v_table, 'a dependent row');
  END;
  -- After the partner, so the uuid map's notice trigger finds no partner to tell
  -- and the delete stays one notice.
  DELETE FROM partner_uuid_map WHERE org_id = p_org AND partner_slug = v_slug;
END
$$;
COMMENT ON FUNCTION public._delete_partner_config(uuid, uuid, uuid, text, jsonb) IS
  'The one body of both delete_partner_config overloads (#2140). Internal: it is reached only through them.';
REVOKE ALL ON FUNCTION public._delete_partner_config(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. delete_partner_config with the reviewed consequence ───────────────────
CREATE OR REPLACE FUNCTION public.delete_partner_config(p_org uuid, p_id uuid, p_actor uuid, p_actor_email text, p_expected jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_expected IS NULL THEN
    RAISE EXCEPTION 'expected_consequence_invalid' USING ERRCODE = 'BP422', DETAIL = 'expected is required';
  END IF;
  PERFORM public._delete_partner_config(p_org, p_id, p_actor, p_actor_email, p_expected);
END
$$;
COMMENT ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text, jsonb) IS
  'Delete a partner and its sub-account IDs, as reviewed (#2140). p_expected is the delete check''s fingerprint: {counts: {table: rows}, workflows: [{id, updated_at}]}. Refuses partner_not_found (P0002), partner_has_dependents (BP023, detail names the tables), partner_delete_consequence_changed (BP024, detail counts or workflows) and expected_consequence_invalid (BP422). Service role only.';
REVOKE ALL ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text, jsonb) TO service_role;

-- ── 6. delete_partner_config, the release before's signature ─────────────────
-- As in 20260921221007, through the shared body: it now deletes the partner's
-- sub-account IDs too, and refuses on blockers before the delete rather than
-- from the foreign key's error (same code, BP023).
CREATE OR REPLACE FUNCTION public.delete_partner_config(p_org uuid, p_id uuid, p_actor uuid, p_actor_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM public._delete_partner_config(p_org, p_id, p_actor, p_actor_email, NULL);
END
$$;
COMMENT ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) IS
  'Delete a partner and its sub-account IDs with the actor recorded on its audit row (#1409, #2140), without a reviewed consequence: the release before #2140 calls it. Refuses partner_has_dependents (BP023, detail names the tables) and partner_not_found (P0002). The profile cascades; sales block.';
REVOKE ALL ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) TO service_role;

-- ── 7. change_partner_uuid ───────────────────────────────────────────────────
-- As in 20261016170000, except the add's check locks the partner row (FOR KEY
-- SHARE), so an add racing a delete waits for it and then finds no partner.
CREATE OR REPLACE FUNCTION public.change_partner_uuid(
  p_org uuid,
  p_slug text,
  p_uuid text,
  p_action text,
  p_actor uuid,
  p_actor_email text,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row jsonb;
BEGIN
  IF p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'action_invalid' USING ERRCODE = 'BP422', DETAIL = coalesce(p_action, 'null');
  END IF;
  IF nullif(p_slug, '') IS NULL OR nullif(p_uuid, '') IS NULL THEN
    RAISE EXCEPTION 'slug_and_uuid_required' USING ERRCODE = 'BP422';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = 'BP422';
  END IF;

  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.actor_name', coalesce(p_actor_name, ''), true);

  IF p_action = 'add' THEN
    -- A mapping names a partner of this organization; another organization's
    -- slug is refused as no such partner. The lock waits out a delete of the
    -- partner in flight (#2140), which then leaves nothing to find.
    PERFORM 1 FROM partner_configs WHERE organization_id = p_org AND slug = p_slug FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002', DETAIL = p_slug;
    END IF;
    INSERT INTO partner_uuid_map (org_id, partner_slug, uuid)
    VALUES (p_org, p_slug, p_uuid)
    RETURNING to_jsonb(partner_uuid_map.*) INTO v_row;
  ELSE
    -- Only this organization's mapping; a mapping whose partner has since gone
    -- can still be removed.
    DELETE FROM partner_uuid_map
    WHERE org_id = p_org AND partner_slug = p_slug AND uuid = p_uuid
    RETURNING to_jsonb(partner_uuid_map.*) INTO v_row;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'uuid_not_found' USING ERRCODE = 'P0002', DETAIL = p_uuid;
    END IF;
  END IF;
  RETURN v_row;
END
$$;
COMMENT ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) IS
  'Adds or removes one sub-account ID mapping (#2135) with bidspoke.actor_* set first, so the partner_uuid_map triggers see who made it. add locks the partner row FOR KEY SHARE (#2140) and refuses a slug that names no partner of p_org (partner_not_found, P0002) and a taken uuid (23505); remove refuses a mapping p_org does not hold (uuid_not_found, P0002). action_invalid, slug_and_uuid_required, actor_required (BP422). Returns the row.';
REVOKE ALL ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) TO service_role;
