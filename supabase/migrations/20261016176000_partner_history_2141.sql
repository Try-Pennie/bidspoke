-- The partners page History records each change once, and names who made it
-- (#2141, PR10 of #2114).
--
-- History reads two sources: audit_log (partner settings, the buyer profile,
-- the bid matrix configs, sub-account IDs and held clicks) and
-- bid_config_history (the Salesforce matrix syncs). This migration makes both
-- able to say who made each change, and records sub-account ID changes once.
--
-- 1. audit_actor_stamp(p_actor): the one place an audit trigger decides how a
--    row names who made it. A person (p_actor set) gets _actor { name, email }
--    as of the write; with no person, a job that set bidspoke.actor_job gets
--    _source 'job' and _job <name>, so a later automatic writer is credited by
--    name; with neither, _source 'direct_sql'. Internal: no grant to anyone.
-- 2. partner_configs_audit: the body production runs (md5(prosrc)
--    02f71f0f80566e295d7deb5c316abc84 on 2026-10-15, the body of
--    20261015010000), with its actor block replaced by audit_actor_stamp. A
--    person's row is unchanged; a no actor write under bidspoke.actor_job is
--    now credited to the job instead of reading as a hand edit.
-- 3. buyer_profile_tables_direct_sql_audit: the body production runs (md5
--    fb5edc954599fd54cf782828cd297ea7, the body of 20261016000000), with its
--    _source 'direct_sql' taken from audit_actor_stamp(NULL), so a job is
--    credited the same way. It becomes SECURITY DEFINER, because it now calls
--    an internal function the Worker's role cannot execute, and a buyer profile
--    write made as service_role must keep landing. Its skip list is unchanged,
--    so a write save_buyer_profile, save_partner_page or delete_partner_config
--    already audits is still never recorded twice.
-- 4. partner_uuid_map_audit: sub-account ID changes had no audit row of their
--    own until now except the Worker's (none in production: the 7 map rows date
--    from 2026-04-21). One row per mapping per change, entity partner_uuid,
--    carrying partner_id (resolved from the slug within the organization), the
--    changed fields as { old, new }, and the stamp. The actor is the one
--    change_partner_uuid (#2135) sets, so the Worker's own two audit writes are
--    removed in the same pull request. No function writes partner_uuid_map and
--    audits it itself, so the trigger has no skip list.
-- 5. bid_config_history.changed_by references users(id), as
--    audit_log.changed_by does, so a Sync now press recorded there always
--    resolves to a name or an address (production holds 0 rows on 2026-10-15).
--
-- Expand only (docs/adr/0007): one new internal function, two trigger functions
-- replaced with their signatures kept, one new trigger function and three
-- triggers, one foreign key on a column no row fills.
--
-- Deploy order (L640). Applied before the Worker that stops writing its own
-- sub-account ID audit rows, a deployed Worker keeps working: its RPC call is
-- unchanged and its writeAuditLog insert still lands. In that window a
-- sub-account ID change is recorded twice, once by the trigger and once by the
-- Worker, and the Worker's row carries no partner_id, so History (which ties a
-- partner_uuid row to its partner by changes.partner_id) shows only the
-- trigger's.

-- ── 1. The stamp ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.audit_actor_stamp(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_name text;
  v_email text;
  v_job text;
BEGIN
  IF p_actor IS NOT NULL THEN
    -- The name and address of THIS write's actor, as they are now (L37).
    SELECT u.display_name, u.email INTO v_name, v_email FROM public.users u WHERE u.id = p_actor;
    -- A missing users row, or one with no name or address, falls back to what
    -- the writing function carried in for this actor.
    v_name := coalesce(nullif(v_name, ''), nullif(current_setting('bidspoke.actor_name', true), ''));
    v_email := coalesce(nullif(v_email, ''), nullif(current_setting('bidspoke.actor_email', true), ''));
    RETURN jsonb_build_object('_actor', jsonb_build_object('name', v_name, 'email', v_email));
  END IF;
  -- A job writing partner settings sets bidspoke.actor_job to its name for its
  -- transaction. None does today: the hourly Salesforce matrix sync, the only
  -- automatic writer of partner settings, records itself in bid_config_history,
  -- and partner_daily_counts holds counts the cap Durable Object writes, not
  -- settings, so no trigger audits it.
  v_job := nullif(current_setting('bidspoke.actor_job', true), '');
  IF v_job IS NOT NULL THEN
    RETURN jsonb_build_object('_source', 'job', '_job', v_job);
  END IF;
  RETURN jsonb_build_object('_source', 'direct_sql');
END
$$;
COMMENT ON FUNCTION public.audit_actor_stamp(uuid) IS
  'How an audit trigger names who made a change (#2141): _actor { name, email } for a person, else _source job and _job from bidspoke.actor_job, else _source direct_sql. Internal to the audit triggers; executable by no role but its owner.';
REVOKE ALL ON FUNCTION public.audit_actor_stamp(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. partner_configs_audit ─────────────────────────────────────────────────
-- As in 20261015010000, with the actor block replaced by audit_actor_stamp.

CREATE OR REPLACE FUNCTION public.partner_configs_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_excluded text[] := public.partner_configs_unversioned_columns();
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_changes jsonb;
  v_actor uuid;
  v_reason text;
  v_context jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(keys.k, jsonb_build_object('old', v_old -> keys.k, 'new', v_new -> keys.k)), '{}'::jsonb)
  INTO v_changes
  FROM (
    SELECT DISTINCT x.k FROM (
      SELECT jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) AS k
      UNION ALL
      SELECT jsonb_object_keys(coalesce(v_new, '{}'::jsonb))
    ) x
  ) keys
  WHERE keys.k <> ALL (v_excluded)
    AND coalesce(v_old -> keys.k, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> keys.k, 'null'::jsonb);

  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_actor := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  IF v_actor IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_actor := NEW.updated_by;
    ELSIF TG_OP = 'UPDATE' THEN
      v_actor := nullif(current_setting('bidspoke.updated_by_actor', true), '')::uuid;
    END IF;
  END IF;
  -- Never NEW.updated_by_name, which a rename leaves holding the previous editor.
  v_changes := v_changes || public.audit_actor_stamp(v_actor);

  v_reason := nullif(current_setting('bidspoke.audit_reason', true), '');
  IF v_reason IS NOT NULL THEN
    v_changes := v_changes || jsonb_build_object('reason', v_reason);
  END IF;
  v_context := nullif(current_setting('bidspoke.audit_context', true), '')::jsonb;
  IF v_context IS NOT NULL AND jsonb_typeof(v_context) = 'object' THEN
    v_changes := v_changes || (v_context - 'reason');
  END IF;

  INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (
    coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid,
    'partner_config',
    coalesce(v_new ->> 'id', v_old ->> 'id')::uuid,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    v_actor,
    v_changes
  );

  -- The captured updated_by belongs to this statement only.
  PERFORM set_config('bidspoke.updated_by_actor', '', true);
  RETURN NULL;
END
$$;
-- service_role too: a trigger function needs no grant to fire.
REVOKE ALL ON FUNCTION public.partner_configs_audit() FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. buyer_profile_tables_direct_sql_audit ─────────────────────────────────
-- As in 20261016000000, with the stamp from audit_actor_stamp(NULL), and
-- SECURITY DEFINER so the call is made as the owner.

CREATE OR REPLACE FUNCTION public.buyer_profile_tables_direct_sql_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_handled text := nullif(current_setting('bidspoke.audit_handled', true), '');
  v_action text := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END;
  v_stamp jsonb;
BEGIN
  IF v_handled IN ('save_buyer_profile', 'save_partner_page', 'delete_partner_config', 'buyer_profile_version_bump') THEN
    RETURN NULL;
  END IF;
  v_stamp := public.audit_actor_stamp(NULL);
  IF TG_OP = 'DELETE' THEN
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM old_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              v_stamp || jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  ELSE
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM new_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              v_stamp || jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_tables_direct_sql_audit() FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. partner_uuid_map_audit ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_uuid_map_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_actor uuid := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  v_partner uuid;
  v_old_partner uuid;
  v_changes jsonb := '{}'::jsonb;
  k text;
BEGIN
  -- The partner the mapping names, in the mapping's own organization (a slug is
  -- unique only within one). A slug naming no partner leaves partner_id null:
  -- the change is still recorded, and appears in no partner's History.
  SELECT p.id INTO v_partner FROM public.partner_configs p
  WHERE p.organization_id = (v_row ->> 'org_id')::uuid AND p.slug = v_row ->> 'partner_slug';
  IF TG_OP = 'UPDATE' AND (v_old ->> 'partner_slug') IS DISTINCT FROM (v_new ->> 'partner_slug') THEN
    SELECT p.id INTO v_old_partner FROM public.partner_configs p
    WHERE p.organization_id = (v_old ->> 'org_id')::uuid AND p.slug = v_old ->> 'partner_slug';
  END IF;

  FOREACH k IN ARRAY ARRAY['partner_slug', 'uuid'] LOOP
    IF coalesce(v_old -> k, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> k, 'null'::jsonb) THEN
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
    END IF;
  END LOOP;
  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_changes := v_changes || jsonb_build_object('partner_id', v_partner) || public.audit_actor_stamp(v_actor);
  -- A hand UPDATE that moves a mapping to another partner shows in both
  -- partners' History.
  IF v_old_partner IS NOT NULL AND v_old_partner IS DISTINCT FROM v_partner THEN
    v_changes := v_changes || jsonb_build_object('old_partner_id', v_old_partner);
  END IF;

  INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (
    (v_row ->> 'org_id')::uuid,
    'partner_uuid',
    (v_row ->> 'id')::uuid,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    v_actor,
    v_changes
  );
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION public.partner_uuid_map_audit() IS
  'One audit_log row (entity partner_uuid, entity_id the mapping id) per sub-account ID mapping per change (#2141), carrying partner_id, the changed fields as { old, new } and audit_actor_stamp of bidspoke.actor_id, which change_partner_uuid sets.';
REVOKE ALL ON FUNCTION public.partner_uuid_map_audit() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS partner_uuid_map_audit_ins ON public.partner_uuid_map;
DROP TRIGGER IF EXISTS partner_uuid_map_audit_upd ON public.partner_uuid_map;
DROP TRIGGER IF EXISTS partner_uuid_map_audit_del ON public.partner_uuid_map;
CREATE TRIGGER partner_uuid_map_audit_ins AFTER INSERT ON public.partner_uuid_map
  FOR EACH ROW EXECUTE FUNCTION public.partner_uuid_map_audit();
CREATE TRIGGER partner_uuid_map_audit_upd AFTER UPDATE ON public.partner_uuid_map
  FOR EACH ROW EXECUTE FUNCTION public.partner_uuid_map_audit();
CREATE TRIGGER partner_uuid_map_audit_del AFTER DELETE ON public.partner_uuid_map
  FOR EACH ROW EXECUTE FUNCTION public.partner_uuid_map_audit();

-- ── 5. bid_config_history.changed_by names a users row ───────────────────────

ALTER TABLE public.bid_config_history
  ADD CONSTRAINT bid_config_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);
COMMENT ON COLUMN public.bid_config_history.changed_by IS
  'The person who pressed Sync now (#2141), or null for the hourly Salesforce matrix sync. References users(id) with NO ACTION, as audit_log.changed_by does, so a referenced users row cannot be deleted and every recorded press resolves to a name or an address.';
