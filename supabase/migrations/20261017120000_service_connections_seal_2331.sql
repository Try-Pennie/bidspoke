-- Close the Slack bot token exposure (#2331, phase 1 of #1689). EXPAND step.
--
-- 1. The browser roles lose every privilege on service_connections. The
--    platform's default grants gave anon and authenticated SELECT on this table,
--    and the Slack bot token sits in config.bot_token in plain text, so anyone
--    holding the public key could read it. No browser code reads the table (a
--    grep of apps/web/src at this PR found none; the web reaches it only through
--    the Worker's /api/integrations and /api/connections routes, which run as
--    service_role), so nothing is granted back. Revoked on each role directly,
--    not only on PUBLIC (L541). This alone closes the exposure, at once.
--
-- 2. Two nullable columns: credential_enc, the token locked with the Worker's
--    key ring (lib/secret-crypto.ts), and sealed_for, which key it is locked
--    for. Release 1 writes both the ciphertext and config.bot_token (dual
--    write), because the code before this release, the rollback target, reads
--    only config.bot_token (L640). The plaintext is stripped, and a CHECK forbids
--    config ? 'bot_token', only in the contract release, after every slack row's
--    credential_enc is shown to open under the current key and to hold the same
--    token as config.bot_token (F128, L5).
--
-- 3. One audit_log row per change at the table, whoever made it (constraint k,
--    L593), modelled on partner_configs_audit (#1409) so it names the actor the
--    same way and the Worker's route audit writes are removed in the same
--    release: one record per change, not two (F119). The actor:
--      1. bidspoke.actor_id, a transaction local setting delete_service_connection
--         sets (a PostgREST delete cannot carry one otherwise);
--      2. on an INSERT, NEW.updated_by, which every app write sets;
--      3. on an UPDATE whose statement SET updated_by, that value, captured by a
--         BEFORE UPDATE OF updated_by trigger (an app update always sets it, a
--         hand run one does not).
--    A change with no actor is labelled _source: direct_sql with changed_by null.
--    The setting names are this table's own, so a transaction touching
--    partner_configs too cannot pass an actor between the two.
--
--    What is recorded, stated so a new column is a conscious choice (L657):
--    every column's old and new value except updated_at, updated_by and
--    updated_by_email (bookkeeping about the change), schema_cache (a large
--    synced copy; schema_synced_at records the sync), and the two that hold the
--    secret. config is recorded with its bot_token key removed, and bot_token and
--    credential_enc are each recorded only as {changed, old_present,
--    new_present}, never their values (L529). A later migration that adds a
--    column to this table extends this function in the same change.
--
--    The coupling is accepted and bounded: an AFTER trigger makes each write
--    depend on its audit insert in the same transaction, so a failed audit
--    insert fails the write. Each function carries lock_timeout 2s and turns any
--    failure of the insert into the named error connection_audit_failed, so a
--    stuck audit insert surfaces by name within the bound rather than hanging a
--    save.
--
-- 4. delete_service_connection(org, service_type, actor): the one delete the
--    Worker routes use, so a disconnect is audited under its user. service_role
--    only.
--
-- Expand only: two nullable columns, a CHECK each new value already satisfies,
-- revokes, triggers and a function. The code before this release keeps working
-- against it: it never reads the new columns, and its route audit rows simply
-- sit beside the trigger's for the minutes between this migration and the
-- deploy (the same accepted window as #1409; the other order would leave a gap).

-- ── 1. Revoke the browser roles ──────────────────────────────────────────────

REVOKE ALL ON TABLE public.service_connections FROM PUBLIC;
REVOKE ALL ON TABLE public.service_connections FROM anon;
REVOKE ALL ON TABLE public.service_connections FROM authenticated;

-- ── 2. The sealed credential ─────────────────────────────────────────────────

ALTER TABLE public.service_connections
  ADD COLUMN IF NOT EXISTS credential_enc text NULL,
  ADD COLUMN IF NOT EXISTS sealed_for text NULL;

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_sealed_for_check
    CHECK (sealed_for IN ('bidding_ring', 'ops_key')),
  -- A ciphertext always says which key it is locked for, so a reader never has
  -- to guess which ring to try.
  ADD CONSTRAINT service_connections_sealed_names_key
    CHECK (credential_enc IS NULL OR sealed_for IS NOT NULL);

COMMENT ON COLUMN public.service_connections.credential_enc IS
  'The connection''s credential, locked with the key named by sealed_for (#2331). For bidding_ring: lib/secret-crypto.ts under secretKeys(env), and the Slack bot token while config.bot_token still holds the plaintext copy (dual write until the contract release). Never selected by a browser role.';
COMMENT ON COLUMN public.service_connections.sealed_for IS
  'Which key locks credential_enc: bidding_ring (the Worker''s SECRET_ENCRYPTION_KEY ring) or ops_key (the ops public key, from Phase 3 of #1689). Null exactly when there is no credential_enc.';

-- ── 3. The store level audit ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.service_connections_capture_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fires only when the statement set updated_by. Cleared by the audit trigger.
  PERFORM set_config('bidspoke.sc_updated_by_actor', coalesce(NEW.updated_by::text, ''), true);
  RETURN NEW;
END
$$;

CREATE TRIGGER service_connections_capture_actor
  BEFORE UPDATE OF updated_by ON public.service_connections
  FOR EACH ROW EXECUTE FUNCTION public.service_connections_capture_actor();

CREATE OR REPLACE FUNCTION public.service_connections_audit()
RETURNS trigger
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  -- Recorded separately below (config, bot_token, credential_enc) or not at all.
  v_excluded text[] := ARRAY['updated_at', 'updated_by', 'updated_by_email', 'schema_cache', 'config', 'credential_enc'];
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
    v_changes := v_changes || jsonb_build_object('_source', 'direct_sql');
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

CREATE TRIGGER service_connections_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.service_connections
  FOR EACH ROW EXECUTE FUNCTION public.service_connections_audit();

-- The captured updated_by belongs to one statement. It is cleared by statement
-- triggers, not by the row audit: every BEFORE row trigger of a statement runs
-- before any AFTER row trigger, so a row audit that cleared it would leave the
-- later rows of a multi row UPDATE labelled direct_sql. Cleared before each
-- UPDATE statement (so nothing earlier in the transaction can leak in) and
-- after it (row level AFTER triggers fire before statement level ones).
CREATE OR REPLACE FUNCTION public.service_connections_clear_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('bidspoke.sc_updated_by_actor', '', true);
  RETURN NULL;
END
$$;

CREATE TRIGGER service_connections_clear_actor_before
  BEFORE UPDATE ON public.service_connections
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_connections_clear_actor();

CREATE TRIGGER service_connections_clear_actor_after
  AFTER UPDATE ON public.service_connections
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_connections_clear_actor();

-- ── 4. The audited delete ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_service_connection(p_organization_id uuid, p_service_type text, p_actor uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Transaction local, so it names this call's delete and nothing after it.
  PERFORM set_config('bidspoke.actor_id', coalesce(p_actor::text, ''), true);
  RETURN QUERY
    DELETE FROM public.service_connections sc
    WHERE sc.organization_id = p_organization_id AND sc.service_type = p_service_type
    RETURNING sc.id;
  PERFORM set_config('bidspoke.actor_id', '', true);
END
$$;

REVOKE ALL ON FUNCTION public.delete_service_connection(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_service_connection(uuid, text, uuid) TO service_role;
