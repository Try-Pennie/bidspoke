-- Each Slack alert writer changes only its own keys of the alert row's config
-- (#2643). EXPAND step: two new functions, nothing altered or dropped.
--
-- The Slack alert login's settings live in one service_connections.config
-- object, and both of its writers used to replace the whole object with the
-- copy they had read: the token save (the Connections page's Reconnect and
-- POST /api/integrations/slack, through saveSlackAlertConnection) and the alert
-- settings save (PATCH /api/integrations/slack/settings: the channel and the
-- four switches). When the two ran at once, the later write put back the
-- other's old values, a switch just turned off coming back on, or a workspace
-- name just learned reverting, with both answering success.
--
-- Each writer now sends only the keys it owns, and the function merges them
-- into the row's config in the one UPDATE, `config || patch`, which Postgres
-- evaluates against the row as it stands once it holds the row's lock. So two
-- writers racing each keep their change, whichever commits first (proven with
-- two sessions in supabase/tests/slack_alert_config_own_keys.test.sql).
--
--   save_slack_alert_token(org, credential_enc, config, actor, actor_email)
--     The token save. Upserts the organization's one alert row on
--     UNIQUE (organization_id, service_type, name) as the Worker's upsert did,
--     with the sealed token in credential_enc, and merges `config`, which may
--     name only workspace_name and default_channel (the token save keys
--     below). A Reconnect sends workspace_name alone; the first connect sends
--     both. Returns the row's id, config and credential_enc as written, which
--     the Worker's saved Slack copy is rebuilt from.
--
--   save_slack_alert_settings(org, connection_id, settings, actor)
--     The settings save. Merges `settings`, which may name only the channel
--     and the four switches (the settings keys below), into the alert row with
--     that id, only within the named organization, and never an ops_key row.
--     Returns that row's id, config and credential_enc as written, or no row
--     when there is no such alert row (another organization's, an ops row, a
--     row removed meanwhile), which the route answers as not connected.
--
-- Both refuse a key outside their list, or a value of the wrong type, by name
-- (slack_alert_config_refused, 22023), so a writer can never again send a key
-- it read but does not own. Both name the actor in updated_by, so the table's
-- audit trigger records the change under the user, as before.
--
-- Expand and contract (CLAUDE.md, ADR 0007): nothing the code running when
-- this is applied (or its rollback target) uses is changed. The code in the
-- pull request carrying this migration calls these functions, and the deploy
-- refuses while a merged migration is unapplied (#1829), so it never runs
-- before they exist. There is no contract step: the Worker's direct upsert and
-- update of the row simply stop.
--
-- Who can call them: service_role only (the Worker). Whose data: the one alert
-- row of the organization named, which the Worker takes from the caller's
-- verified token, never from the request.

CREATE OR REPLACE FUNCTION public.save_slack_alert_token(
  p_organization_id uuid,
  p_credential_enc text,
  p_config jsonb,
  p_actor uuid,
  p_actor_email text
)
RETURNS TABLE (id uuid, config jsonb, credential_enc text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
#variable_conflict use_column
DECLARE
  -- token save keys: the keys of config the token save owns.
  v_keys text[] := ARRAY['workspace_name', 'default_channel'];
  v_extra text[];
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_credential_enc IS NULL OR p_credential_enc = '' THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the sealed token is required' USING ERRCODE = '22023';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the config must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_extra FROM jsonb_object_keys(p_config) k WHERE k <> ALL (v_keys);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the token save does not own %', array_to_string(v_extra, ', ') USING ERRCODE = '22023';
  END IF;
  IF (p_config ? 'workspace_name' AND jsonb_typeof(p_config -> 'workspace_name') NOT IN ('string', 'null'))
     OR (p_config ? 'default_channel' AND (jsonb_typeof(p_config -> 'default_channel') <> 'string' OR p_config ->> 'default_channel' = '')) THEN
    RAISE EXCEPTION 'slack_alert_config_refused: workspace_name must be text or null, and default_channel non empty text' USING ERRCODE = '22023';
  END IF;

  -- updated_by names the actor for the audit (service_connections_capture_actor).
  RETURN QUERY
    INSERT INTO public.service_connections AS sc
      (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
    VALUES
      (p_organization_id, 'slack', 'slack', 'bot_token', NULL, p_config, p_credential_enc, 'bidding_ring', p_actor, p_actor_email)
    ON CONFLICT (organization_id, service_type, name) DO UPDATE
      SET config = CASE WHEN jsonb_typeof(sc.config) = 'object' THEN sc.config ELSE '{}'::jsonb END || excluded.config,
          auth_type = excluded.auth_type,
          cf_secret_key = NULL,
          credential_enc = excluded.credential_enc,
          sealed_for = excluded.sealed_for,
          updated_by = excluded.updated_by,
          updated_by_email = excluded.updated_by_email
    RETURNING sc.id, sc.config, sc.credential_enc;
END
$$;

REVOKE ALL ON FUNCTION public.save_slack_alert_token(uuid, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_slack_alert_token(uuid, text, jsonb, uuid, text) TO service_role;

COMMENT ON FUNCTION public.save_slack_alert_token(uuid, text, jsonb, uuid, text) IS
  'The Slack alert token save (#2643): upserts the organization''s one alert row with the sealed token and merges workspace_name and default_channel into its config, leaving every other key as the row holds it, audited under the actor. Returns id, config and credential_enc as written. Refuses any other key by name (slack_alert_config_refused). service_role only.';

CREATE OR REPLACE FUNCTION public.save_slack_alert_settings(
  p_organization_id uuid,
  p_connection_id uuid,
  p_settings jsonb,
  p_actor uuid
)
RETURNS TABLE (id uuid, config jsonb, credential_enc text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
#variable_conflict use_column
DECLARE
  -- settings keys: the keys of config the settings save owns.
  v_keys text[] := ARRAY['default_channel', 'volume_alerts_enabled', 'matrix_alerts_enabled', 'config_alerts_enabled', 'backup_alerts_enabled'];
  v_extra text[];
  v_bad text[];
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the organization and the connection are required' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the settings must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_extra FROM jsonb_object_keys(p_settings) k WHERE k <> ALL (v_keys);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: the settings save does not own %', array_to_string(v_extra, ', ') USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_bad
  FROM jsonb_each(p_settings) e(k, v)
  WHERE (k = 'default_channel' AND (jsonb_typeof(v) <> 'string' OR v #>> '{}' = ''))
     OR (k <> 'default_channel' AND jsonb_typeof(v) <> 'boolean');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'slack_alert_config_refused: % must be a switch (true or false), or for default_channel non empty text', array_to_string(v_bad, ', ') USING ERRCODE = '22023';
  END IF;

  -- The alert row only, as lib/slack-connection.ts defines it: service type
  -- and name slack, sealed for the ring or the legacy unsealed form.
  -- updated_by names the actor for the audit (service_connections_capture_actor).
  RETURN QUERY
    UPDATE public.service_connections sc
    SET config = CASE WHEN jsonb_typeof(sc.config) = 'object' THEN sc.config ELSE '{}'::jsonb END || p_settings,
        updated_by = p_actor
    WHERE sc.id = p_connection_id
      AND sc.organization_id = p_organization_id
      AND sc.service_type = 'slack'
      AND sc.name = 'slack'
      AND (sc.sealed_for = 'bidding_ring' OR sc.sealed_for IS NULL)
    RETURNING sc.id, sc.config, sc.credential_enc;
END
$$;

REVOKE ALL ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid) IS
  'The Slack alert settings save (#2643): merges the channel and the four alert switches into the named alert row''s config, only within the named organization and never an ops_key row, leaving every other key as the row holds it, audited under the actor. Returns id, config and credential_enc as written, or no row when there is no such alert row. Refuses any other key or a wrong type by name (slack_alert_config_refused). service_role only.';
