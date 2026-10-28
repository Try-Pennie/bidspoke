-- The Slack alert settings save names who changed a setting (#2870). EXPAND
-- step: one new function, nothing altered or dropped.
--
-- save_slack_alert_settings (20261027170000, #2643) set updated_by but never
-- updated_by_email, so GET /api/integrations/slack, which answers
-- updated_by_email as who last changed the alert settings, went on naming
-- whoever last saved the bot token (save_slack_alert_token writes both).
--
--   save_slack_alert_settings(org, connection_id, settings, actor, actor_email)
--     The four argument save with the changer's email added: it writes
--     updated_by_email as given, as the token save does, NULL included, so an
--     unknown email clears the token saver's name rather than leaving it on a
--     change they did not make. Everything else is the four argument body.
--
-- Why a second function and not a replace: a new argument is a new signature,
-- which CREATE OR REPLACE cannot give an existing function, and the Worker
-- deployed when this is applied calls the four argument form by its four
-- argument names. So the four argument form stays exactly as it is, and the
-- fifth argument has NO default: with one, a call naming four arguments would
-- match both forms and PostgREST would refuse it as ambiguous. PostgREST picks
-- the form by the argument names a call sends, so the deployed Worker keeps
-- calling the four argument form and the Worker in this change the five.
--
-- Expand and contract (CLAUDE.md, ADR 0007): applying this changes nothing
-- the running code uses. The Worker in the same pull request calls the five
-- argument form, and the deploy refuses while a merged migration is unapplied
-- (#1829, the five argument probe in supabase/required-live-objects.json), so
-- it never runs before this exists. CONTRACT, later: once that Worker is live
-- and its rollback floor is past it, drop
-- save_slack_alert_settings(uuid, uuid, jsonb, uuid).
--
-- Who can call it: service_role only (the Worker). Whose data: the one alert
-- row of the organization named, which the Worker takes from the caller's
-- verified token, never from the request.

CREATE OR REPLACE FUNCTION public.save_slack_alert_settings(
  p_organization_id uuid,
  p_connection_id uuid,
  p_settings jsonb,
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
  -- updated_by names the actor for the audit (service_connections_capture_actor),
  -- and updated_by_email names them to whoever reads the settings next.
  RETURN QUERY
    UPDATE public.service_connections sc
    SET config = CASE WHEN jsonb_typeof(sc.config) = 'object' THEN sc.config ELSE '{}'::jsonb END || p_settings,
        updated_by = p_actor,
        updated_by_email = p_actor_email
    WHERE sc.id = p_connection_id
      AND sc.organization_id = p_organization_id
      AND sc.service_type = 'slack'
      AND sc.name = 'slack'
      AND (sc.sealed_for = 'bidding_ring' OR sc.sealed_for IS NULL)
    RETURNING sc.id, sc.config, sc.credential_enc;
END
$$;

REVOKE ALL ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text) TO service_role;

COMMENT ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text) IS
  'The Slack alert settings save naming its changer (#2870): merges the channel and the four alert switches into the named alert row''s config, only within the named organization and never an ops_key row, and writes updated_by and updated_by_email as the actor. Returns id, config and credential_enc as written, or no row when there is no such alert row. Refuses any other key or a wrong type by name (slack_alert_config_refused). service_role only. Replaces the four argument form, which the contract step drops.';
