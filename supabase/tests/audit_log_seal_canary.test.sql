-- The audit row of POST /api/admin/seal-canary, against the real audit_log (#2333).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHY. The route's test (apps/worker/src/routes/api/__tests__/admin-seal-canary.test.ts)
-- reads its audit row back from a database double that refuses what audit_log
-- refuses. That read back is only as good as the double, so this proves the
-- real table refuses the same rows: a text entity id and an email as changed_by
-- (what the reencrypt route writes, and recordAuditLog then drops after its
-- retries), a changed_by naming no user, and a null entity id. And it proves the
-- row the route does write lands and reads back by its entity id. If audit_log's
-- columns change, this fails, and the double must change with it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside a DO block, counted and compared at the bottom.

CREATE TEMP TABLE IF NOT EXISTS alsc_cases (name text PRIMARY KEY);
DELETE FROM alsc_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112333c', 'ALSC Org', 'alsc-org-2333') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222333c', '11111111-1111-1111-1111-11111112333c', 'alsc2333@example.test', 'ALSC User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112333c';
END
$do$;

-- 1. The route's row lands, and reads back by the drill id it returns.
DO $do$
DECLARE
  drill uuid := gen_random_uuid();
  a record;
  n int;
BEGIN
  INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES ('11111111-1111-1111-1111-11111112333c', 'ops_key_restore_drill', drill, 'canary_sealed',
          '22222222-2222-2222-2222-22222222333c', '{"kid":"ops-2026-10"}');
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_id = drill;
  IF n <> 1 THEN RAISE EXCEPTION 'case 1: % rows read back for the drill id', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE entity_id = drill;
  IF a.entity_type <> 'ops_key_restore_drill' OR a.action <> 'canary_sealed' THEN RAISE EXCEPTION 'case 1: read back as % %', a.entity_type, a.action; END IF;
  IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222333c' THEN RAISE EXCEPTION 'case 1: changed_by read back as %', a.changed_by; END IF;
  IF a.changes ->> 'kid' IS DISTINCT FROM 'ops-2026-10' THEN RAISE EXCEPTION 'case 1: changes read back as %', a.changes; END IF;
  INSERT INTO alsc_cases VALUES ('the route''s row lands and reads back by its drill id');
END
$do$;

-- 2. A text entity id is refused, as the double refuses it.
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES ('11111111-1111-1111-1111-11111112333c', 'recovery_secret', 'SECRET_ENCRYPTION_KEY', 'secrets_reencrypted',
            '22222222-2222-2222-2222-22222222333c', '{}');
    RAISE EXCEPTION 'case 2: a text entity id was accepted';
  EXCEPTION WHEN invalid_text_representation THEN
    INSERT INTO alsc_cases VALUES ('a text entity id is refused (22P02)');
  END;
END
$do$;

-- 3. An email as changed_by is refused, as the double refuses it.
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES ('11111111-1111-1111-1111-11111112333c', 'ops_key_restore_drill', gen_random_uuid(), 'canary_sealed',
            'alsc2333@example.test', '{}');
    RAISE EXCEPTION 'case 3: an email was accepted as changed_by';
  EXCEPTION WHEN invalid_text_representation THEN
    INSERT INTO alsc_cases VALUES ('an email as changed_by is refused (22P02)');
  END;
END
$do$;

-- 4. A changed_by naming no user is refused, as the double refuses it.
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES ('11111111-1111-1111-1111-11111112333c', 'ops_key_restore_drill', gen_random_uuid(), 'canary_sealed',
            '33333333-3333-3333-3333-33333333333c', '{}');
    RAISE EXCEPTION 'case 4: a changed_by naming no user was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO alsc_cases VALUES ('a changed_by naming no user is refused (23503)');
  END;
END
$do$;

-- 5. A null entity id is refused, as the double refuses it.
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES ('11111111-1111-1111-1111-11111112333c', 'ops_key_restore_drill', NULL, 'canary_sealed',
            '22222222-2222-2222-2222-22222222333c', '{}');
    RAISE EXCEPTION 'case 5: a null entity id was accepted';
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO alsc_cases VALUES ('a null entity id is refused (23502)');
  END;
END
$do$;

DO $do$
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112333c';
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM alsc_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'audit_log_seal_canary.test.sql: % cases passed', n;
END
$do$;
