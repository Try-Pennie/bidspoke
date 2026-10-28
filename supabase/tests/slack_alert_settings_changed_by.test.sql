-- save_slack_alert_settings names who changed a setting, not who saved the
-- token (#2870), migration 20261027230000, and the four argument form it
-- replaced is gone (#2896), migration 20261028020000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The ciphertexts
-- below are planted placeholders, not credentials, and the people are invented.
--
-- WHY: the settings save set updated_by but never updated_by_email, so
-- GET /api/integrations/slack, which answers updated_by_email as who last
-- changed the alert settings, went on naming whoever last saved the bot token.
--
-- WHAT IT PROVES (each inside a block that is rolled back):
--   A. Control: the row every case starts from names the token saver in
--      updated_by_email, so the cases after it measure the fix, not a row that
--      never held a stale name.
--   B. A settings save by a second person, through the five argument form,
--      names that person in updated_by and updated_by_email, merges only its
--      keys, and keeps the sealed token.
--   C. A settings save whose email is not known clears the email rather than
--      leaving the token saver's name on a change they did not make.
--   D. The five argument form refuses a key it does not own, a wrong type and
--      a missing actor, and writes nothing.
--   E. Contracted (#2896): only the five argument form exists, a call sending
--      the four old arguments finds no function, and the fifth argument has no
--      default, so a call that leaves the email out is refused rather than
--      quietly clearing the changer's name. It is service_role only, SECURITY
--      DEFINER, search_path set.
--   F. The contract migration drops only the four argument form: run against a
--      database that still has it, it removes that form and leaves the five
--      argument form with its grants; run again, it changes nothing.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS sacb_cases (name text PRIMARY KEY);
DELETE FROM sacb_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112870', 'SACB Org', 'sacb-org-2870') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name) VALUES
    ('22222222-2222-2222-2222-222222222870', '11111111-1111-1111-1111-111111112870', 'token-saver-2870@example.test', 'Token Saver'),
    ('22222222-2222-2222-2222-22222222287b', '11111111-1111-1111-1111-111111112870', 'settings-changer-2870@example.test', 'Settings Changer')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-111111112870';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111112870';
END
$do$;

-- The row every case starts from: the alert row as the first person's token
-- save leaves it, naming them in updated_by and updated_by_email.
CREATE OR REPLACE FUNCTION pg_temp.sacb_row()
RETURNS uuid
LANGUAGE sql
AS $$
  SELECT id FROM public.save_slack_alert_token(
    '11111111-1111-1111-1111-111111112870', 'planted-ciphertext-2870',
    '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie"}',
    '22222222-2222-2222-2222-222222222870', 'token-saver-2870@example.test')
$$;

-- ── A. Control: the starting row names the token saver ──────────────────────
DO $do$
DECLARE
  v_id uuid;
  s record;
BEGIN
  BEGIN
    v_id := pg_temp.sacb_row();
    SELECT updated_by, updated_by_email INTO s FROM public.service_connections WHERE id = v_id;
    IF s.updated_by IS DISTINCT FROM '22222222-2222-2222-2222-222222222870'::uuid
       OR s.updated_by_email IS DISTINCT FROM 'token-saver-2870@example.test' THEN
      RAISE EXCEPTION 'control: the starting row names % (%), not the token saver, so cases B and C prove nothing', s.updated_by_email, s.updated_by;
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sacb_cases VALUES ('control: the row every case starts from names the token saver');
END
$do$;

-- ── B. A second person's settings save names them ───────────────────────────
DO $do$
DECLARE
  v_id uuid;
  r record;
  s record;
BEGIN
  BEGIN
    v_id := pg_temp.sacb_row();
    SELECT * INTO r FROM public.save_slack_alert_settings(
      '11111111-1111-1111-1111-111111112870', v_id, '{"volume_alerts_enabled": false}',
      '22222222-2222-2222-2222-22222222287b', 'settings-changer-2870@example.test');
    IF r.id IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'the settings save returned row %', r.id; END IF;
    SELECT updated_by, updated_by_email, config, credential_enc, sealed_for INTO s FROM public.service_connections WHERE id = v_id;
    IF s.updated_by_email IS DISTINCT FROM 'settings-changer-2870@example.test' THEN
      RAISE EXCEPTION 'a settings save by a second person left updated_by_email as %', s.updated_by_email;
    END IF;
    IF s.updated_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222287b'::uuid THEN
      RAISE EXCEPTION 'a settings save by a second person left updated_by as %', s.updated_by;
    END IF;
    IF s.config <> '{"default_channel": "#bidspoke-alerts", "workspace_name": "Pennie", "volume_alerts_enabled": false}'::jsonb THEN
      RAISE EXCEPTION 'the settings save left config %', s.config;
    END IF;
    IF s.credential_enc IS DISTINCT FROM 'planted-ciphertext-2870' OR s.sealed_for IS DISTINCT FROM 'bidding_ring'
       OR r.credential_enc IS DISTINCT FROM s.credential_enc OR r.config IS DISTINCT FROM s.config THEN
      RAISE EXCEPTION 'the settings save changed the token or returned a row other than as written (% %)', s.credential_enc, r.config;
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sacb_cases VALUES ('a settings save by a second person names them in updated_by and updated_by_email');
END
$do$;

-- ── C. An unknown email clears the token saver's name ───────────────────────
DO $do$
DECLARE
  v_id uuid;
  s record;
BEGIN
  BEGIN
    v_id := pg_temp.sacb_row();
    PERFORM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112870', v_id, '{"matrix_alerts_enabled": false}', '22222222-2222-2222-2222-22222222287b', NULL);
    SELECT updated_by, updated_by_email INTO s FROM public.service_connections WHERE id = v_id;
    IF s.updated_by_email IS NOT NULL OR s.updated_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222287b'::uuid THEN
      RAISE EXCEPTION 'a settings save with no email left % by %', s.updated_by_email, s.updated_by;
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sacb_cases VALUES ('a settings save whose email is unknown clears the token saver''s name');
END
$do$;

-- ── D. The five argument form refuses a key it does not own, a wrong type and a missing actor ──
DO $do$
DECLARE
  v_id uuid;
  bad record;
  s record;
  refused boolean;
BEGIN
  BEGIN
    v_id := pg_temp.sacb_row();
    FOR bad IN
      SELECT * FROM (VALUES
        ('{"workspace_name": "Theirs"}'::jsonb, '22222222-2222-2222-2222-22222222287b'::uuid),
        ('{"volume_alerts_enabled": "false"}'::jsonb, '22222222-2222-2222-2222-22222222287b'::uuid),
        ('{"volume_alerts_enabled": false}'::jsonb, NULL::uuid)
      ) v(patch, actor)
    LOOP
      refused := false;
      BEGIN
        PERFORM public.save_slack_alert_settings('11111111-1111-1111-1111-111111112870', v_id, bad.patch, bad.actor, 'settings-changer-2870@example.test');
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE 'slack_alert_config_refused:%' THEN RAISE; END IF;
        refused := true;
      END;
      IF NOT refused THEN RAISE EXCEPTION 'the five argument save took % from %', bad.patch, bad.actor; END IF;
    END LOOP;
    SELECT updated_by_email, config INTO s FROM public.service_connections WHERE id = v_id;
    IF s.updated_by_email IS DISTINCT FROM 'token-saver-2870@example.test' OR s.config ? 'volume_alerts_enabled' THEN
      RAISE EXCEPTION 'a refused save wrote (% %)', s.updated_by_email, s.config;
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sacb_cases VALUES ('the five argument save refuses a key it does not own, a wrong type and a missing actor, and writes nothing');
END
$do$;

-- ── E. Contracted: only the five argument form, service_role only ──────────
DO $do$
DECLARE
  fn text := 'public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text)';
  r text;
  p record;
  v_id uuid;
  refused boolean;
BEGIN
  IF to_regprocedure('public.save_slack_alert_settings(uuid, uuid, jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the four argument settings save is still there after the contract step (#2896)';
  END IF;
  IF to_regprocedure(fn) IS NULL THEN
    RAISE EXCEPTION 'the five argument settings save the Worker calls is gone';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_slack_alert_settings' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one settings save, the five argument one';
  END IF;
  -- A default on the email would let a call that leaves it out save and
  -- write a NULL changer, instead of being refused as the old call shape.
  IF (SELECT pronargdefaults FROM pg_proc WHERE oid = to_regprocedure(fn)) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the five argument settings save has a default, so a call without the email still saves';
  END IF;
  -- The four argument names, as the Worker deployed before #2870 sent them.
  -- PostgREST picks a function by the names a call sends, as named notation does here.
  BEGIN
    v_id := pg_temp.sacb_row();
    refused := false;
    BEGIN
      PERFORM public.save_slack_alert_settings(
        p_organization_id => '11111111-1111-1111-1111-111111112870', p_connection_id => v_id,
        p_settings => '{"volume_alerts_enabled": false}', p_actor => '22222222-2222-2222-2222-22222222287b');
    EXCEPTION WHEN undefined_function THEN
      refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'a call sending the four old arguments still found a function'; END IF;
    IF (SELECT config ? 'volume_alerts_enabled' FROM public.service_connections WHERE id = v_id) THEN
      RAISE EXCEPTION 'a refused four argument call wrote the row';
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
  SELECT prosecdef, proconfig INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
  IF NOT p.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '% is not SECURITY DEFINER with its search_path set', fn;
  END IF;
  INSERT INTO sacb_cases VALUES ('only the five argument form exists, a four argument call finds nothing, and only service_role may call it');
END
$do$;

-- ── F. The contract migration drops the four argument form and nothing else ──
-- It runs the migration file itself, read from the migrations folder the
-- harness copies into the container (scripts/sql-suite/project.sh).
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261028020000_drop_four_argument_slack_settings_save_2896.sql');
  five text := 'public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text)';
  five_oid oid := to_regprocedure('public.save_slack_alert_settings(uuid, uuid, jsonb, uuid, text)');
BEGIN
  BEGIN
    -- The four argument form as production held it before the drop: its
    -- signature and grants, with a stub body, since only the signature is
    -- what the drop names.
    CREATE FUNCTION public.save_slack_alert_settings(p_organization_id uuid, p_connection_id uuid, p_settings jsonb, p_actor uuid)
    RETURNS TABLE (id uuid, config jsonb, credential_enc text)
    LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
    AS $f$ SELECT NULL::uuid, NULL::jsonb, NULL::text WHERE false $f$;
    REVOKE ALL ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.save_slack_alert_settings(uuid, uuid, jsonb, uuid) TO service_role;
    IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_slack_alert_settings' AND pronamespace = 'public'::regnamespace) <> 2 THEN
      RAISE EXCEPTION 'control: the four argument form was not put back, so this case proves nothing';
    END IF;

    EXECUTE v_file;
    IF to_regprocedure('public.save_slack_alert_settings(uuid, uuid, jsonb, uuid)') IS NOT NULL THEN
      RAISE EXCEPTION 'the contract migration left the four argument form';
    END IF;
    IF to_regprocedure(five) IS DISTINCT FROM five_oid THEN
      RAISE EXCEPTION 'the contract migration dropped or recreated the five argument form';
    END IF;
    IF NOT has_function_privilege('service_role', five, 'EXECUTE') OR has_function_privilege('anon', five, 'EXECUTE') THEN
      RAISE EXCEPTION 'the contract migration changed who may call the five argument form';
    END IF;

    -- Run again, on a database where the four argument form is already gone.
    EXECUTE v_file;
    IF to_regprocedure(five) IS DISTINCT FROM five_oid
       OR (SELECT count(*) FROM pg_proc WHERE proname = 'save_slack_alert_settings' AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'running the contract migration again changed the settings saves';
    END IF;
    RAISE EXCEPTION 'sacb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sacb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sacb_cases VALUES ('the contract migration drops only the four argument form, and runs again cleanly');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM sacb_cases);
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-111111112870') THEN
    RAISE EXCEPTION 'a case''s rows were left behind';
  END IF;
  IF n <> 6 THEN RAISE EXCEPTION 'expected 6 cases, % ran', n; END IF;
  RAISE NOTICE 'slack_alert_settings_changed_by.test.sql: % cases passed', n;
END
$do$;
