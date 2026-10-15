-- A step rename names ITS editor on the partner row (#2151, part of #2114).
--
-- rename_partner_step_namespace rewrites a partner's formula columns when a
-- workflow step id is renamed. It set updated_by and updated_by_email to the
-- renaming user but left updated_by_name alone, so the partners page footer
-- ("Modified ... by <name>") went on crediting whoever saved the partner before.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds by replaying every migration from empty, never production. Fixed ids
-- used nowhere else, no real identity. Fixtures are deleted first so a rerun is
-- idempotent.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, each
-- counted into suite_cases; the last statement compares the count with the
-- number written there (L288). IS DISTINCT FROM, never <>.
--
-- Mutations tried (each turned its case red, then was put back):
-- - before the fix migration existed (20260921221007's body): case 1 red, the
--   row still named Alice;
-- - the name looked up without the organization filter: case 3 red (Carol);
-- - updated_by_name left out of the SET list: case 1 red, and cases 2 and 3
--   each red when run on their own (the row still named Alice).

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

DO $do$
BEGIN
  DELETE FROM public.partner_configs WHERE organization_id IN ('11111111-1111-1111-1111-111111112151', '11111111-1111-1111-1111-111111112152');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-111111112151', '11111111-1111-1111-1111-111111112152');
  DELETE FROM public.users WHERE organization_id IN ('11111111-1111-1111-1111-111111112151', '11111111-1111-1111-1111-111111112152');
  DELETE FROM public.organizations WHERE id IN ('11111111-1111-1111-1111-111111112151', '11111111-1111-1111-1111-111111112152');
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112151', 'Rename Org', 'rename-org-2151');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112152', 'Other Rename Org', 'other-rename-org-2151');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222215a', '11111111-1111-1111-1111-111111112151', 'alice2151@example.test', 'Alice Rename');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222215b', '11111111-1111-1111-1111-111111112151', 'bob2151@example.test', 'Bob Rename');
-- A user with no display name (the column is nullable).
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222215d', '11111111-1111-1111-1111-111111112151', 'dana2151@example.test', NULL);
-- A user of ANOTHER organization, whose name must never be stamped on this one's partner.
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222215c', '11111111-1111-1111-1111-111111112152', 'carol2151@example.test', 'Carol Elsewhere');
-- Three partners, each last saved by Alice through the app's insert shape.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, bid_formula, updated_by, updated_by_email, updated_by_name)
VALUES
  ('33333333-3333-3333-3333-333333332151', '11111111-1111-1111-1111-111111112151', 'Rename Buyer A', 'rename-buyer-a-2151', 'buyer', true, 'steps.old.output.x', '22222222-2222-2222-2222-22222222215a', 'alice2151@example.test', 'Alice Rename'),
  ('33333333-3333-3333-3333-333333332152', '11111111-1111-1111-1111-111111112151', 'Rename Buyer B', 'rename-buyer-b-2151', 'buyer', true, 'steps.old.output.x', '22222222-2222-2222-2222-22222222215a', 'alice2151@example.test', 'Alice Rename'),
  ('33333333-3333-3333-3333-333333332153', '11111111-1111-1111-1111-111111112151', 'Rename Buyer C', 'rename-buyer-c-2151', 'buyer', true, 'steps.old.output.x', '22222222-2222-2222-2222-22222222215a', 'alice2151@example.test', 'Alice Rename');

-- ── 1. A rename by Bob on a partner last saved by Alice leaves Bob's name ─────
DO $do$
DECLARE n integer; r record; v_actor jsonb;
BEGIN
  n := public.rename_partner_step_namespace('11111111-1111-1111-1111-111111112151', '33333333-3333-3333-3333-333333332151',
    '{"bid_formula":"steps.renamed.output.x"}'::jsonb, '22222222-2222-2222-2222-22222222215b', 'bob2151@example.test', '{"reason":"step_id_renamed"}'::jsonb);
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the rename should touch one row, touched %', n; END IF;
  SELECT updated_by, updated_by_email, updated_by_name INTO r FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332151';
  IF r.updated_by_name IS DISTINCT FROM 'Bob Rename' THEN
    RAISE EXCEPTION 'a rename by Bob on a partner last saved by Alice left updated_by_name %', r.updated_by_name;
  END IF;
  IF r.updated_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222215b'::uuid OR r.updated_by_email IS DISTINCT FROM 'bob2151@example.test' THEN
    RAISE EXCEPTION 'the rename left updated_by % and updated_by_email %', r.updated_by, r.updated_by_email;
  END IF;
  -- The audit row still names the same actor the row now does.
  SELECT changes -> '_actor' INTO v_actor FROM public.audit_log
  WHERE entity_id = '33333333-3333-3333-3333-333333332151' AND changes ? 'bid_formula'
  ORDER BY changed_at DESC, id DESC LIMIT 1;
  IF v_actor ->> 'name' IS DISTINCT FROM 'Bob Rename' THEN RAISE EXCEPTION 'the rename audit row stamped _actor %', v_actor; END IF;
  INSERT INTO suite_cases(name) VALUES ('rename names its own editor');
END
$do$;

-- ── 2. An actor with no display name: the name is cleared, never left as Alice ──
-- The footer then falls back to updated_by_email, which is the renaming user's.
-- (An actor with no users row at all cannot reach here: updated_by references
-- users, so that rename is refused by the foreign key.)
DO $do$
DECLARE r record;
BEGIN
  PERFORM public.rename_partner_step_namespace('11111111-1111-1111-1111-111111112151', '33333333-3333-3333-3333-333333332152',
    '{"bid_formula":"steps.renamed.output.x"}'::jsonb, '22222222-2222-2222-2222-22222222215d', 'dana2151@example.test', '{"reason":"step_id_renamed"}'::jsonb);
  SELECT updated_by_email, updated_by_name INTO r FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332152';
  IF r.updated_by_name IS NOT NULL THEN
    RAISE EXCEPTION 'a rename by an actor with no display name left updated_by_name %, which names a previous editor', r.updated_by_name;
  END IF;
  IF r.updated_by_email IS DISTINCT FROM 'dana2151@example.test' THEN RAISE EXCEPTION 'the rename left updated_by_email %', r.updated_by_email; END IF;
  INSERT INTO suite_cases(name) VALUES ('nameless actor clears the name');
END
$do$;

-- ── 3. A users row in ANOTHER organization is not read for the name ──────────
DO $do$
DECLARE r record;
BEGIN
  PERFORM public.rename_partner_step_namespace('11111111-1111-1111-1111-111111112151', '33333333-3333-3333-3333-333333332153',
    '{"bid_formula":"steps.renamed.output.x"}'::jsonb, '22222222-2222-2222-2222-22222222215c', 'carol2151@example.test', '{"reason":"step_id_renamed"}'::jsonb);
  SELECT updated_by_name INTO r FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332153';
  IF r.updated_by_name IS NOT NULL THEN
    RAISE EXCEPTION 'a rename stamped the name of a user from another organization: %', r.updated_by_name;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('name read only within the organization');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'partner_rename_editor_name.test.sql: expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_rename_editor_name.test.sql: % cases passed', n;
END
$do$;
