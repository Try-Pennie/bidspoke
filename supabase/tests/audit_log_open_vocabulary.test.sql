-- audit_log constrains neither entity_type nor action (#471).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds,
-- never production. Production was read on 2026-10-13 and holds no CHECK on
-- audit_log either.
--
-- WHY. The vocabulary of both columns lives in TypeScript (AuditEntityType and
-- AuditAction in apps/worker/src/lib/audit.ts), and new values are added there
-- with no migration. That is only safe while the table accepts any text. A CHECK
-- added later would make every write of a value it does not list fail, and
-- recordAuditLog would retry and then drop it. If this fails, either drop the
-- CHECK or add each value in the unions to it in the same migration.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside a DO block, counted and compared at the bottom.

CREATE TEMP TABLE IF NOT EXISTS al_cases (name text PRIMARY KEY);
DELETE FROM al_cases;

DO $do$
DECLARE
  found text;
BEGIN
  SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), '; ') INTO found
  FROM pg_constraint
  WHERE conrelid = 'public.audit_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ~* '(entity_type|action)';
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'audit_log now has a CHECK on its vocabulary, which the TypeScript unions add to without a migration: %', found;
  END IF;
  INSERT INTO al_cases VALUES ('no CHECK constrains entity_type or action');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM al_cases);
BEGIN
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 case, % ran', n; END IF;
  RAISE NOTICE 'audit_log_open_vocabulary.test.sql: % cases passed', n;
END
$do$;
