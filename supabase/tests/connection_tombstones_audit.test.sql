-- The store level audit of connection_tombstones (#2331, phase 1 of #1689).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The ciphertext
-- below is a planted placeholder, not a credential.
--
-- WHY. A tombstone is what tells the ops Worker a connection was removed, so a
-- hand run delete of one would let a removed login come back on ops. The plan
-- (#2331, constraint k) audits every change of it with its own trigger
-- function, since service_connections_audit reads columns a tombstone has not.
--
-- WHAT IT PROVES:
--   A. remove_ops_connection's tombstone writes exactly one audit row:
--      entity_type connection_tombstone, entity_id the connection's id, action
--      created, naming the remover, with the generation; and the removed row's
--      own audit still names the remover.
--   B. The remover is not named on anything after it in the same transaction:
--      a hand run tombstone insert there is labelled direct_sql.
--   C. A hand run UPDATE records old and new and is labelled direct_sql.
--   D. A hand run DELETE is audited as deleted, with what it held.
--   E. A change to nothing writes no audit row.

CREATE TEMP TABLE IF NOT EXISTS cta_cases (name text PRIMARY KEY);
DELETE FROM cta_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-1111111d2331', 'CTA Org', 'cta-org-2331') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-2222222d2331', '11111111-1111-1111-1111-1111111d2331', 'cta2331@example.test', 'CTA User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.connection_tombstones WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  INSERT INTO public.service_connections (id, organization_id, service_type, name, auth_type, credential_enc, sealed_for, credential_generation)
  VALUES ('33333333-3333-3333-3333-3333333d2331', '11111111-1111-1111-1111-1111111d2331', 'anthropic', 'Lead notes', 'api_key', 'planted-ciphertext-2331', 'ops_key', 4);
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
END
$do$;

-- ── A and B. The remove, then a hand run insert in the same transaction ──────
DO $do$
DECLARE
  r record;
  a record;
  n int;
BEGIN
  SELECT * INTO r FROM public.remove_ops_connection('11111111-1111-1111-1111-1111111d2331', '33333333-3333-3333-3333-3333333d2331', '22222222-2222-2222-2222-2222222d2331');
  IF r.outcome <> 'removed' THEN RAISE EXCEPTION 'the remove answered %', r.outcome; END IF;

  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND entity_type = 'connection_tombstone';
  IF n <> 1 THEN RAISE EXCEPTION 'the remove wrote % tombstone audit rows', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND entity_type = 'connection_tombstone';
  IF a.entity_id IS DISTINCT FROM '33333333-3333-3333-3333-3333333d2331' OR a.action <> 'created' THEN
    RAISE EXCEPTION 'the tombstone was audited as % on %', a.action, a.entity_id;
  END IF;
  IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-2222222d2331' THEN RAISE EXCEPTION 'the tombstone did not name its remover: %', a.changed_by; END IF;
  IF a.changes ? '_source' THEN RAISE EXCEPTION 'the remove''s tombstone was labelled %', a.changes ->> '_source'; END IF;
  IF (a.changes -> 'generation' ->> 'new')::bigint IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'the generation was not recorded: %', a.changes; END IF;
  IF a.changes::text LIKE '%planted-ciphertext%' THEN RAISE EXCEPTION 'the ciphertext reached the tombstone audit'; END IF;

  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND entity_type = 'service_connection';
  IF a.action <> 'deleted' OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-2222222d2331' THEN
    RAISE EXCEPTION 'the removed row was audited as % by %', a.action, a.changed_by;
  END IF;
  INSERT INTO cta_cases VALUES ('the remove''s tombstone is audited once, naming the remover, by the connection id');

  -- B: still the same transaction as the remove.
  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES ('11111111-1111-1111-1111-1111111d2331', '33333333-3333-3333-3333-3333333d2332', 1);
  SELECT * INTO a FROM public.audit_log
  WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND entity_type = 'connection_tombstone' AND entity_id = '33333333-3333-3333-3333-3333333d2332';
  IF a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'a hand insert after the remove was audited by % as %', a.changed_by, a.changes ->> '_source';
  END IF;
  INSERT INTO cta_cases VALUES ('the remover is not named on a later write in the same transaction');
END
$do$;

-- ── C. A hand run UPDATE ─────────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
  n int;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  UPDATE public.connection_tombstones SET generation = 9
  WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND connection_id = '33333333-3333-3333-3333-3333333d2331';
  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  IF n <> 1 THEN RAISE EXCEPTION 'a hand UPDATE wrote % audit rows', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  IF a.action <> 'updated' OR a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'a hand UPDATE was audited as % by % (%)', a.action, a.changed_by, a.changes ->> '_source';
  END IF;
  IF (a.changes -> 'generation' ->> 'old')::bigint IS DISTINCT FROM 4 OR (a.changes -> 'generation' ->> 'new')::bigint IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'the UPDATE did not record old and new: %', a.changes;
  END IF;
  INSERT INTO cta_cases VALUES ('a hand UPDATE records old and new and is labelled direct_sql');
END
$do$;

-- ── D. A hand run DELETE ─────────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  DELETE FROM public.connection_tombstones
  WHERE organization_id = '11111111-1111-1111-1111-1111111d2331' AND connection_id = '33333333-3333-3333-3333-3333333d2331';
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  IF a IS NULL OR a.action <> 'deleted' OR a.entity_id IS DISTINCT FROM '33333333-3333-3333-3333-3333333d2331' THEN
    RAISE EXCEPTION 'a hand DELETE of a tombstone was audited as %', a;
  END IF;
  IF (a.changes -> 'generation' ->> 'old')::bigint IS DISTINCT FROM 9 OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'the DELETE did not record what it held: %', a.changes;
  END IF;
  INSERT INTO cta_cases VALUES ('a hand DELETE of a tombstone is audited with what it held');
END
$do$;

-- ── E. A change to nothing ───────────────────────────────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  UPDATE public.connection_tombstones SET generation = generation
  WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  IF n <> 0 THEN RAISE EXCEPTION 'an UPDATE that changed nothing wrote % audit rows', n; END IF;
  INSERT INTO cta_cases VALUES ('a change to nothing writes no audit row');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.connection_tombstones WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM cta_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'connection_tombstones_audit.test.sql: % cases passed', n;
END
$do$;
