-- Drop service_connections.schema_cache and schema_synced_at (#2567), the
-- contract step after #2338 build PR 4.
--
-- The expand half is live: #2566 (shipped 2026-10-20) retired the schema sync
-- route and deleted the fetchers that filled both columns, so they have neither
-- a writer nor a reader (docs/adr/0007-expand-contract-migrations.md). Nothing
-- in apps, packages, scripts or supabase names either column; the one database
-- object that did is the audit trigger below, whose list of columns it leaves
-- unrecorded named schema_cache. No view, index, constraint, trigger column
-- list or publication depends on either column (measured in the SQL suite).
--
-- What is lost: schema_cache held a synced copy of a connected service's
-- schema, which the service itself still holds, and schema_synced_at when that
-- copy was taken. Neither is the record of anything Bidspoke decided.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.service_connections
  DROP COLUMN IF EXISTS schema_cache,
  DROP COLUMN IF EXISTS schema_synced_at;

-- The audit trigger as 20261018191000_store_rotated_envelope_2335.sql left it,
-- less schema_cache in the columns it leaves unrecorded: every remaining column
-- outside that list is still recorded, as before.
CREATE OR REPLACE FUNCTION public.service_connections_audit()
RETURNS trigger
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  -- Recorded separately below (config, bot_token, credential_enc) or not at all.
  v_excluded text[] := ARRAY['updated_at', 'updated_by', 'updated_by_email', 'config', 'credential_enc'];
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_old_config jsonb := v_old -> 'config';
  v_new_config jsonb := v_new -> 'config';
  v_old_token text;
  v_new_token text;
  v_changes jsonb;
  v_actor uuid;
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

  -- The token, read only to say whether it is there and whether it changed.
  v_old_token := CASE WHEN jsonb_typeof(v_old_config) = 'object' THEN v_old_config ->> 'bot_token' END;
  v_new_token := CASE WHEN jsonb_typeof(v_new_config) = 'object' THEN v_new_config ->> 'bot_token' END;
  IF jsonb_typeof(v_old_config) = 'object' THEN v_old_config := v_old_config - 'bot_token'; END IF;
  IF jsonb_typeof(v_new_config) = 'object' THEN v_new_config := v_new_config - 'bot_token'; END IF;

  IF coalesce(v_old_config, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new_config, 'null'::jsonb) THEN
    v_changes := v_changes || jsonb_build_object('config', jsonb_build_object('old', v_old_config, 'new', v_new_config));
  END IF;
  IF v_old_token IS DISTINCT FROM v_new_token THEN
    v_changes := v_changes || jsonb_build_object('bot_token', jsonb_build_object(
      'changed', true, 'old_present', v_old_token IS NOT NULL, 'new_present', v_new_token IS NOT NULL));
  END IF;
  IF (v_old ->> 'credential_enc') IS DISTINCT FROM (v_new ->> 'credential_enc') THEN
    v_changes := v_changes || jsonb_build_object('credential_enc', jsonb_build_object(
      'changed', true, 'old_present', (v_old ->> 'credential_enc') IS NOT NULL, 'new_present', (v_new ->> 'credential_enc') IS NOT NULL));
  END IF;

  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_actor := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  IF v_actor IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_actor := NEW.updated_by;
    ELSIF TG_OP = 'UPDATE' THEN
      v_actor := nullif(current_setting('bidspoke.sc_updated_by_actor', true), '')::uuid;
    END IF;
  END IF;
  IF v_actor IS NULL THEN
    -- A system writer names itself (store_rotated_envelope sets ops_token_rotation
    -- for its one UPDATE, #2335); anything else is a direct write, as before.
    v_changes := v_changes || jsonb_build_object('_source', coalesce(nullif(current_setting('bidspoke.sc_source', true), ''), 'direct_sql'));
  END IF;

  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES (
      coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid,
      'service_connection',
      coalesce(v_new ->> 'id', v_old ->> 'id')::uuid,
      CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
      v_actor,
      v_changes
    );
  EXCEPTION WHEN OTHERS THEN
    -- The reason only: SQLERRM of a failed insert names a lock, a constraint or
    -- a missing relation, never a value from this row.
    RAISE EXCEPTION 'connection_audit_failed' USING ERRCODE = 'BP503', DETAIL = SQLSTATE || ': ' || SQLERRM;
  END;

  RETURN NULL;
END
$$;
