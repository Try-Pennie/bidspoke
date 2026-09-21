-- Audit at the lowest layer every write path shares: the table (#1409, L593).
--
-- Until now every audit row for partner_configs came from four Worker call
-- sites, each recording a list of changed field NAMES and no values, and a
-- hand run UPDATE (Tripoint's pricing has been edited that way) recorded
-- nothing at all. Yet this row decides where each sell off lead's PII is posted
-- and what it is priced at. So: one AFTER row trigger writes one audit_log row
-- per change with the old and new value of every audited column (L529), and
-- the four Worker writes are removed in the same release so there is one
-- record per change, not two. The few minutes of double rows while the
-- migration is applied ahead of the deploy are accepted; the other order would
-- leave a gap.
--
-- Who did it. The database cannot see the person behind a service_role
-- connection, so the actor is resolved the same way for every operation:
--   1. bidspoke.actor_id, a transaction local setting the delete and rename
--      functions set;
--   2. on an INSERT, NEW.updated_by, which the app always sets;
--   3. on an UPDATE whose statement SET updated_by (even to the same value),
--      that value, captured by a BEFORE UPDATE OF updated_by trigger into a
--      transaction local setting. A column list trigger fires only when the
--      column is in the SET list, which is what tells an app update (always
--      sets it) from a hand run one (never does).
-- A row with no actor resolved is labelled _source: direct_sql with changed_by
-- null. An app action is never labelled direct SQL, and hand run SQL never
-- inherits the last app editor (L192).
--
-- Excluded columns, stated so a new column is a conscious choice (L657):
-- updated_at, updated_by, updated_by_email, updated_by_name (bookkeeping about
-- the change, not the change) and last_probe_response (rewritten by a probe,
-- not by a person). accept_signals and response_classification are audited,
-- because they now decide sale outcomes. cf_secret_key holds a secret NAME,
-- never a value, so auditing it copies no credential into audit_log.
--
-- The profile tables get a lighter detector: an AFTER statement trigger per
-- table and event that, when the statement was not one of the two functions
-- that own those tables, writes one audit_log row per affected partner
-- labelled direct_sql. The functions announce themselves through
-- bidspoke.audit_handled, so their own writes stay silent.
--
-- Expand only: triggers and their functions; no shape changes.

CREATE OR REPLACE FUNCTION public.partner_configs_capture_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fires only when the statement set updated_by. Cleared by the audit trigger.
  PERFORM set_config('bidspoke.updated_by_actor', coalesce(NEW.updated_by::text, ''), true);
  RETURN NEW;
END
$$;

CREATE TRIGGER partner_configs_capture_actor
  BEFORE UPDATE OF updated_by ON public.partner_configs
  FOR EACH ROW EXECUTE FUNCTION public.partner_configs_capture_actor();

CREATE OR REPLACE FUNCTION public.partner_configs_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_excluded text[] := ARRAY['updated_at', 'updated_by', 'updated_by_email', 'updated_by_name', 'last_probe_response'];
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
  IF v_actor IS NULL THEN
    v_changes := v_changes || jsonb_build_object('_source', 'direct_sql');
  END IF;

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

CREATE TRIGGER partner_configs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.partner_configs
  FOR EACH ROW EXECUTE FUNCTION public.partner_configs_audit();

-- ── Direct SQL detector on the four profile tables ───────────────────────────

CREATE OR REPLACE FUNCTION public.buyer_profile_tables_direct_sql_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_handled text := nullif(current_setting('bidspoke.audit_handled', true), '');
  v_action text := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END;
BEGIN
  IF v_handled IN ('save_buyer_profile', 'delete_partner_config') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM old_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              jsonb_build_object('_source', 'direct_sql', 'table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  ELSE
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM new_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              jsonb_build_object('_source', 'direct_sql', 'table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER buyer_profiles_direct_sql_ins AFTER INSERT ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_profiles_direct_sql_upd AFTER UPDATE ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_profiles_direct_sql_del AFTER DELETE ON public.buyer_profiles
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();

CREATE TRIGGER buyer_operating_windows_direct_sql_ins AFTER INSERT ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_operating_windows_direct_sql_upd AFTER UPDATE ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_operating_windows_direct_sql_del AFTER DELETE ON public.buyer_operating_windows
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();

CREATE TRIGGER buyer_blackout_dates_direct_sql_ins AFTER INSERT ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_blackout_dates_direct_sql_upd AFTER UPDATE ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_blackout_dates_direct_sql_del AFTER DELETE ON public.buyer_blackout_dates
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();

CREATE TRIGGER buyer_pricing_tiers_direct_sql_ins AFTER INSERT ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_pricing_tiers_direct_sql_upd AFTER UPDATE ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
CREATE TRIGGER buyer_pricing_tiers_direct_sql_del AFTER DELETE ON public.buyer_pricing_tiers
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_direct_sql_audit();
