-- Every UPDATE of a partner_configs row moves its updated_at (#1846).
--
-- WHY. The Partner Bid node keeps a stored copy of each partner's config in KV
-- (lib/partner-last-good.ts) and rewrites it only when the row's updated_at
-- differs from the one its isolate last wrote. A partner route retires the copy
-- after every edit, and in every OTHER isolate the copy is written afresh only
-- because the edit moved updated_at. If an UPDATE could leave updated_at where it
-- was, those isolates would skip the write and an outage would find no copy at
-- all. The routes never set updated_at themselves (partners.ts sets updated_by,
-- rename_partner_step_namespace sets the formula columns): the
-- partner_configs_updated_at trigger is what moves it, so this asserts the
-- trigger, by behaviour as well as by catalogue.
--
-- HOW. Inside a transaction that is rolled back: a row is written, then updated
-- with an explicit updated_at far in the past. A BEFORE UPDATE trigger setting
-- now() overrides that value; without one the past value would be stored.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds. Fixed ids used nowhere else, no real identity, nothing kept.

BEGIN;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111118460', 'Copy Org', 'copy-org-1846');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-222222228460', '11111111-1111-1111-1111-111111118460', 'copy@example.test', 'Copy User');
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333338460', '11111111-1111-1111-1111-111111118460', 'Copy Buyer', 'copy-buyer-1846', 'buyer', true, '22222222-2222-2222-2222-222222228460', 'copy@example.test');

DO $do$
DECLARE
  v_triggers integer;
  v_stamp timestamptz;
BEGIN
  SELECT count(*) INTO v_triggers
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.partner_configs'::regclass
    AND NOT t.tgisinternal
    AND p.proname = 'set_updated_at'
    AND (t.tgtype & 2) = 2   -- BEFORE
    AND (t.tgtype & 16) = 16; -- UPDATE
  IF v_triggers IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'partner_configs has % BEFORE UPDATE set_updated_at triggers, expected 1', v_triggers;
  END IF;

  UPDATE public.partner_configs
  SET is_active = false, updated_at = '2000-01-01T00:00:00Z'
  WHERE id = '33333333-3333-3333-3333-333333338460';
  SELECT updated_at INTO v_stamp FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333338460';
  IF v_stamp IS NOT DISTINCT FROM '2000-01-01T00:00:00Z'::timestamptz OR v_stamp IS NULL THEN
    RAISE EXCEPTION 'an UPDATE left partner_configs.updated_at at %, so a stored copy keyed on it would not be rewritten', v_stamp;
  END IF;
  IF v_stamp IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'an UPDATE stored updated_at %, expected the statement time %', v_stamp, now();
  END IF;
  RAISE NOTICE 'partner_configs_updated_at_moves.test.sql: 2 of 2 cases passed';
END
$do$;

ROLLBACK;
