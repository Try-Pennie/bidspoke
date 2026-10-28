-- save_slack_alert_token and save_slack_alert_settings: each Slack alert writer
-- changes only its own keys of the alert row's config (#2643), migration
-- 20261027170000. The settings save is called in its five argument form
-- (20261027230000, #2870), the only one left once 20261028020000 dropped the
-- four argument form (#2896).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The ciphertexts
-- below are planted placeholders, not credentials.
--
-- WHY: both writers used to write the whole config object as they had read it,
-- so when a Reconnect and a settings save ran at once the later write put back
-- the other's old values (a switch just turned off came back on, a workspace
-- name just learned reverted), both answering success.
--
-- WHAT IT PROVES (each inside a block that is rolled back, except the races):
--   A. Control: the loss is real. Two whole object writes from one read keep
--      only the later writer's change.
--   B. The settings save merges only its keys: every other key, the token and
--      the seal are kept; it returns the row as written; it is audited under
--      its actor.
--   C. The token save merges only its keys into the existing alert row: the
--      switches and the channel are kept, the sealed token replaced, a legacy
--      unsealed row sealed; and with no row it creates the one alert row.
--   D. The settings save of another organization's row, a missing row, an ops
--      row or a non alert Slack row writes nothing and returns no row.
--   E. Both refuse a key they do not own, a wrong type, or a missing actor,
--      by name, and write nothing.
--   F. Race, settings first: a token save from a second session waits on the
--      settings save's lock, and when both commit the row holds both changes.
--   G. Race, token first: a settings save from a second session waits on the
--      token save's lock, and when both commit the row holds both changes.
--   H. Only service_role may call either; both are SECURITY DEFINER with their
--      search_path set.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

\if :{?self_host}
\else
  \echo 'slack_alert_config_own_keys.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  \quit
\endif
SELECT set_config('sak_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TEMP TABLE IF NOT EXISTS sak_cases (name text PRIMARY KEY);
DELETE FROM sak_cases;

CREATE OR REPLACE FUNCTION pg_temp.sak_clean()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-111111112643', '11111111-1111-1111-1111-11111112643b');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-111111112643', '11111111-1111-1111-1111-11111112643b');
$$;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112643', 'SAK Org', 'sak-org-2643') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112643b', 'SAK Org B', 'sak-org-2643b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name) VALUES
    ('22222222-2222-2222-2222-222222222643', '11111111-1111-1111-1111-111111112643', 'sak2643@example.test', 'SAK User'),
    ('22222222-2222-2222-2222-22222222264b', '11111111-1111-1111-1111-111111112643', 'sak2643b@example.test', 'SAK User B')
  ON CONFLICT (id) DO NOTHING;
  PERFORM pg_temp.sak_clean();
END
$do$;

-- The rows every case starts from: org A's alert row (volume alerts on, the
-- workspace Pennie), a second non alert slack row of org A, an ops slack row of
-- org A, and org B's alert row.
CREATE OR REPLACE FUNCTION pg_temp.sak_rows()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.service_connections (id, organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
  VALUES
    ('33333333-3333-3333-3333-333333332643', '11111111-1111-1111-1111-111111112643', 'slack', 'slack', 'bot_token', NULL,
     '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie", "volume_alerts_enabled": true, "matrix_alerts_enabled": true}',
     'planted-ciphertext-2643-old', 'bidding_ring'),
    ('33333333-3333-3333-3333-33333333264a', '11111111-1111-1111-1111-111111112643', 'slack', 'second slack', 'bot_token', 'CONN_PLANTED_2643',
     '{"volume_alerts_enabled": true}', NULL, NULL),
    ('33333333-3333-3333-3333-33333333264c', '11111111-1111-1111-1111-111111112643', 'slack', 'ops-alerts', 'bot_token', NULL,
     '{"volume_alerts_enabled": true}', 'planted-ops-ciphertext-2643', 'ops_key'),
    ('33333333-3333-3333-3333-33333333264b', '11111111-1111-1111-1111-11111112643b', 'slack', 'slack', 'bot_token', NULL,
     '{"default_channel": "#theirs", "volume_alerts_enabled": true}', 'planted-ciphertext-2643-b', 'bidding_ring');
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.sak_config(p_id uuid)
RETURNS jsonb
LANGUAGE sql
AS $$ SELECT config FROM public.service_connections WHERE id = p_id $$;

-- ── A. Control: two whole object writes from one read lose a change ─────────
DO $do$
DECLARE
  v_read jsonb;
  c jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.sak_rows();
    -- Both writers read the row before either writes, as the Worker did.
    v_read := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
    UPDATE public.service_connections SET config = v_read || '{"volume_alerts_enabled": false}' WHERE id = '33333333-3333-3333-3333-333333332643';
    UPDATE public.service_connections SET config = v_read || '{"workspace_name": "Pennie HQ"}' WHERE id = '33333333-3333-3333-3333-333333332643';
    c := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
    IF c -> 'volume_alerts_enabled' <> 'true'::jsonb THEN
      RAISE EXCEPTION 'control: the whole object writes kept the switch turned off (%), so the case below proves nothing', c;
    END IF;
    RAISE EXCEPTION 'sak_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sak_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sak_cases VALUES ('control: two whole object writes from one read put back the switch just turned off');
END
$do$;

-- ── B. The settings save merges only its keys ───────────────────────────────
DO $do$
DECLARE
  r record;
  n int;
  c jsonb;
  a record;
BEGIN
  BEGIN
    PERFORM pg_temp.sak_rows();
    SELECT count(*) INTO n FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333332643', '{}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF n <> 1 THEN RAISE EXCEPTION 'an empty settings save returned % rows, not the row', n; END IF;
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111112643';

    SELECT * INTO r FROM public.save_slack_alert_settings(
      '11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333332643',
      '{"volume_alerts_enabled": false, "default_channel": "#new-alerts", "backup_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF r.id IS DISTINCT FROM '33333333-3333-3333-3333-333333332643'::uuid THEN RAISE EXCEPTION 'the settings save returned row %', r.id; END IF;
    c := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
    IF c <> '{"default_channel": "#new-alerts", "workspace_name": "Pennie", "volume_alerts_enabled": false, "matrix_alerts_enabled": true, "backup_alerts_enabled": false}'::jsonb THEN
      RAISE EXCEPTION 'the settings save left config %', c;
    END IF;
    IF r.config IS DISTINCT FROM c OR r.credential_enc IS DISTINCT FROM 'planted-ciphertext-2643-old' THEN
      RAISE EXCEPTION 'the settings save returned % %, not the row as written', r.config, r.credential_enc;
    END IF;
    IF (SELECT sealed_for FROM public.service_connections WHERE id = '33333333-3333-3333-3333-333333332643') IS DISTINCT FROM 'bidding_ring' THEN
      RAISE EXCEPTION 'the settings save changed the seal';
    END IF;
    SELECT * INTO a FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332643' AND action = 'updated';
    IF NOT FOUND OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-222222222643'::uuid THEN
      RAISE EXCEPTION 'the settings save was not audited under its actor (%)', a.changed_by;
    END IF;
    RAISE EXCEPTION 'sak_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sak_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sak_cases VALUES ('the settings save merges only its keys, returns the row as written, and is audited under its actor');
END
$do$;

-- ── C. The token save merges only its keys, seals, and creates a missing row ─
DO $do$
DECLARE
  r record;
  c jsonb;
  s record;
  a record;
BEGIN
  BEGIN
    PERFORM pg_temp.sak_rows();
    -- A legacy unsealed alert row, as production held before #2331: no seal, its credential a Cloudflare secret name.
    UPDATE public.service_connections SET sealed_for = NULL, credential_enc = NULL, cf_secret_key = 'CONN_LEGACY_2643' WHERE id = '33333333-3333-3333-3333-333333332643';
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111112643';
    SELECT * INTO r FROM public.save_slack_alert_token(
      '11111111-1111-1111-1111-111111112643', 'planted-ciphertext-2643-new', '{"workspace_name": "Pennie HQ"}',
      '22222222-2222-2222-2222-22222222264b', 'sak2643b@example.test');
    IF r.id IS DISTINCT FROM '33333333-3333-3333-3333-333333332643'::uuid THEN RAISE EXCEPTION 'the token save wrote row %, not the alert row', r.id; END IF;
    c := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
    IF c <> '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie HQ", "volume_alerts_enabled": true, "matrix_alerts_enabled": true}'::jsonb THEN
      RAISE EXCEPTION 'the token save left config %', c;
    END IF;
    IF r.config IS DISTINCT FROM c THEN RAISE EXCEPTION 'the token save returned config %, not the row as written', r.config; END IF;
    SELECT * INTO s FROM public.service_connections WHERE id = '33333333-3333-3333-3333-333333332643';
    IF s.credential_enc <> 'planted-ciphertext-2643-new' OR s.sealed_for IS DISTINCT FROM 'bidding_ring' OR s.auth_type <> 'bot_token'
       OR s.cf_secret_key IS NOT NULL OR s.updated_by_email IS DISTINCT FROM 'sak2643b@example.test' THEN
      RAISE EXCEPTION 'the token save left the row as % % % %', s.credential_enc, s.sealed_for, s.auth_type, s.updated_by_email;
    END IF;
    SELECT * INTO a FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332643' AND action = 'updated';
    IF NOT FOUND OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222264b'::uuid THEN
      RAISE EXCEPTION 'the token save was not audited under its actor (%)', a.changed_by;
    END IF;
    -- The other rows of the organization are untouched.
    IF pg_temp.sak_config('33333333-3333-3333-3333-33333333264a') <> '{"volume_alerts_enabled": true}'::jsonb
       OR pg_temp.sak_config('33333333-3333-3333-3333-33333333264c') <> '{"volume_alerts_enabled": true}'::jsonb THEN
      RAISE EXCEPTION 'the token save reached another Slack row of the organization';
    END IF;

    -- No alert row yet: the first connect creates the one alert row.
    DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112643b';
    SELECT * INTO r FROM public.save_slack_alert_token(
      '11111111-1111-1111-1111-11111112643b', 'planted-ciphertext-2643-first', '{"workspace_name": "B", "default_channel": "#b"}',
      '22222222-2222-2222-2222-222222222643', NULL);
    SELECT * INTO s FROM public.service_connections WHERE id = r.id;
    IF s.organization_id <> '11111111-1111-1111-1111-11111112643b' OR s.name <> 'slack' OR s.service_type <> 'slack'
       OR s.sealed_for IS DISTINCT FROM 'bidding_ring' OR s.config <> '{"workspace_name": "B", "default_channel": "#b"}'::jsonb THEN
      RAISE EXCEPTION 'the first connect created %', to_jsonb(s);
    END IF;
    RAISE EXCEPTION 'sak_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sak_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sak_cases VALUES ('the token save merges only its keys, seals a legacy row, and creates the alert row when there is none');
END
$do$;

-- ── D. The settings save reaches only the organization's alert row ──────────
DO $do$
DECLARE
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.sak_rows();
    -- Org A names org B's alert row.
    SELECT count(*) INTO n FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-33333333264b', '{"volume_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF n <> 0 THEN RAISE EXCEPTION 'a save for org A returned % rows for org B''s row', n; END IF;
    -- A row that does not exist.
    SELECT count(*) INTO n FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333339999', '{"volume_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF n <> 0 THEN RAISE EXCEPTION 'a save of a missing row returned % rows', n; END IF;
    -- The ops row and the second, non alert slack row of org A.
    SELECT count(*) INTO n FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-33333333264c', '{"volume_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF n <> 0 THEN RAISE EXCEPTION 'a save of an ops row returned % rows', n; END IF;
    SELECT count(*) INTO n FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-33333333264a', '{"volume_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
    IF n <> 0 THEN RAISE EXCEPTION 'a save of a non alert slack row returned % rows', n; END IF;
    IF EXISTS (SELECT 1 FROM public.service_connections
               WHERE organization_id IN ('11111111-1111-1111-1111-111111112643', '11111111-1111-1111-1111-11111112643b')
                 AND config -> 'volume_alerts_enabled' = 'false'::jsonb) THEN
      RAISE EXCEPTION 'a refused settings save wrote a row';
    END IF;
    RAISE EXCEPTION 'sak_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sak_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sak_cases VALUES ('the settings save writes nothing for another organization''s row, a missing row, an ops row or a non alert row');
END
$do$;

-- ── E. Keys a writer does not own, wrong types and a missing actor are refused ─
DO $do$
DECLARE
  bad record;
  refused int := 0;
BEGIN
  PERFORM pg_temp.sak_rows();
  FOR bad IN SELECT * FROM (VALUES
    ('settings', '{"workspace_name": "Mallory"}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('settings', '{"bot_token": "xoxb-planted"}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('settings', '{"volume_alerts_enabled": "false"}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('settings', '{"default_channel": ""}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('settings', '[]'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('settings', '{"volume_alerts_enabled": false}'::jsonb, NULL::uuid),
    ('token', '{"volume_alerts_enabled": true}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('token', '{"bot_token": "xoxb-planted"}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('token', '{"default_channel": 7}'::jsonb, '22222222-2222-2222-2222-222222222643'::uuid),
    ('token', '{"workspace_name": "Pennie HQ"}'::jsonb, NULL::uuid)
  ) v(writer, patch, actor) LOOP
    BEGIN
      IF bad.writer = 'settings' THEN
        PERFORM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333332643', bad.patch, bad.actor, 'sak2643@example.test');
      ELSE
        PERFORM public.save_slack_alert_token('11111111-1111-1111-1111-111111112643', 'planted-ciphertext-2643-bad', bad.patch, bad.actor, NULL);
      END IF;
      RAISE EXCEPTION 'the % save took %', bad.writer, bad.patch;
    EXCEPTION WHEN invalid_parameter_value THEN
      IF SQLERRM NOT LIKE 'slack_alert_config_refused:%' THEN RAISE; END IF;
      refused := refused + 1;
    END;
  END LOOP;
  -- An empty sealed token is refused too.
  BEGIN
    PERFORM public.save_slack_alert_token('11111111-1111-1111-1111-111111112643', '', '{}', '22222222-2222-2222-2222-222222222643', NULL);
    RAISE EXCEPTION 'the token save took an empty sealed token';
  EXCEPTION WHEN invalid_parameter_value THEN
    refused := refused + 1;
  END;
  IF refused <> 11 THEN RAISE EXCEPTION 'refused % of 11 bad calls', refused; END IF;
  IF pg_temp.sak_config('33333333-3333-3333-3333-333333332643') <> '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie", "volume_alerts_enabled": true, "matrix_alerts_enabled": true}'::jsonb
     OR (SELECT credential_enc FROM public.service_connections WHERE id = '33333333-3333-3333-3333-333333332643') <> 'planted-ciphertext-2643-old' THEN
    RAISE EXCEPTION 'a refused call wrote the alert row';
  END IF;
  PERFORM pg_temp.sak_clean();
  INSERT INTO sak_cases VALUES ('both refuse a key they do not own, a wrong type, a missing actor or token, by name, and write nothing');
END
$do$;

-- ── F and G. Two sessions racing: both changes are kept ─────────────────────
-- The rows are committed, so the second session sees them.
DO $$ BEGIN PERFORM pg_temp.sak_rows(); END $$;

DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
BEGIN
  IF created THEN CREATE EXTENSION dblink; END IF;
  PERFORM set_config('sak_test.created_dblink', created::text, false);
  PERFORM dblink_connect('sak_b', format('host=%s user=postgres password=postgres dbname=postgres', current_setting('sak_test.self_host')));
END
$do$;

-- The second session's pid, read while it is idle.
CREATE TEMP TABLE sak_b_pid AS SELECT pid FROM dblink('sak_b', 'SELECT pg_backend_pid()') AS t(pid integer);

-- F. The settings save holds the row; the token save from session B waits on it.
DO $do$
DECLARE
  v_pid integer := (SELECT pid FROM sak_b_pid);
  v_waiting boolean := false;
  i integer;
BEGIN
  PERFORM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333332643', '{"volume_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test');
  PERFORM dblink_send_query('sak_b', $q$SELECT id FROM public.save_slack_alert_token('11111111-1111-1111-1111-111111112643', 'planted-ciphertext-2643-race', '{"workspace_name": "Pennie HQ"}', '22222222-2222-2222-2222-22222222264b', NULL)$q$);
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('sak_b');
    RAISE EXCEPTION 'case F: the token save did not wait for the settings save, so this is no race';
  END IF;
END
$do$;

DO $do$
DECLARE
  r record;
  c jsonb;
BEGIN
  SELECT * INTO r FROM dblink_get_result('sak_b', true) AS t(id uuid);
  PERFORM * FROM dblink_get_result('sak_b', true) AS t(id uuid);
  c := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
  IF r.id IS DISTINCT FROM '33333333-3333-3333-3333-333333332643'::uuid THEN RAISE EXCEPTION 'case F: the waiting token save answered %', r.id; END IF;
  IF c <> '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie HQ", "volume_alerts_enabled": false, "matrix_alerts_enabled": true}'::jsonb
     OR (SELECT credential_enc FROM public.service_connections WHERE id = '33333333-3333-3333-3333-333333332643') <> 'planted-ciphertext-2643-race' THEN
    RAISE EXCEPTION 'case F: after the race the row holds %', c;
  END IF;
  INSERT INTO sak_cases VALUES ('a token save racing a settings save waits for it, and the row keeps both changes');
END
$do$;

-- G. The token save holds the row; the settings save from session B waits on it.
DO $do$
DECLARE
  v_pid integer := (SELECT pid FROM sak_b_pid);
  v_waiting boolean := false;
  i integer;
BEGIN
  PERFORM public.save_slack_alert_token('11111111-1111-1111-1111-111111112643', 'planted-ciphertext-2643-race-2', '{"workspace_name": "Pennie Two"}', '22222222-2222-2222-2222-22222222264b', NULL);
  PERFORM dblink_send_query('sak_b', $q$SELECT id FROM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112643', '33333333-3333-3333-3333-333333332643', '{"matrix_alerts_enabled": false}', '22222222-2222-2222-2222-222222222643', 'sak2643@example.test')$q$);
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('sak_b');
    RAISE EXCEPTION 'case G: the settings save did not wait for the token save, so this is no race';
  END IF;
END
$do$;

DO $do$
DECLARE
  r record;
  c jsonb;
BEGIN
  SELECT * INTO r FROM dblink_get_result('sak_b', true) AS t(id uuid);
  PERFORM * FROM dblink_get_result('sak_b', true) AS t(id uuid);
  c := pg_temp.sak_config('33333333-3333-3333-3333-333333332643');
  IF r.id IS DISTINCT FROM '33333333-3333-3333-3333-333333332643'::uuid THEN RAISE EXCEPTION 'case G: the waiting settings save answered %', r.id; END IF;
  IF c <> '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie Two", "volume_alerts_enabled": false, "matrix_alerts_enabled": false}'::jsonb
     OR (SELECT credential_enc FROM public.service_connections WHERE id = '33333333-3333-3333-3333-333333332643') <> 'planted-ciphertext-2643-race-2' THEN
    RAISE EXCEPTION 'case G: after the race the row holds %', c;
  END IF;
  INSERT INTO sak_cases VALUES ('a settings save racing a token save waits for it, and the row keeps both changes');
END
$do$;

DO $do$
BEGIN
  PERFORM dblink_disconnect('sak_b');
  IF current_setting('sak_test.created_dblink', true) = 'true' THEN DROP EXTENSION dblink; END IF;
END
$do$;
DO $$ BEGIN PERFORM pg_temp.sak_clean(); END $$;

-- ── H. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  fn text;
  r text;
  p record;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.save_slack_alert_token(uuid, text, jsonb, uuid, text)', 'public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
    SELECT prosecdef, proconfig INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
    IF NOT p.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER with its search_path set', fn;
    END IF;
  END LOOP;
  INSERT INTO sak_cases VALUES ('only service_role may call either, each SECURITY DEFINER with its search_path set');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM sak_cases);
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-111111112643', '11111111-1111-1111-1111-11111112643b')) THEN
    RAISE EXCEPTION 'a case''s rows were left behind';
  END IF;
  IF n <> 8 THEN RAISE EXCEPTION 'expected 8 cases, % ran', n; END IF;
  RAISE NOTICE 'slack_alert_config_own_keys.test.sql: % cases passed', n;
END
$do$;
