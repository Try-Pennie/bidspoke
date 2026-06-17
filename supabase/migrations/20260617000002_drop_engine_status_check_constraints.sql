-- Drop the remaining engine hot-path enum CHECK constraints on
-- execution_steps (status, error_type) and workflow_executions (status).
--
-- These mirror the StepStatus / ErrorType / execution-status string unions in
-- apps/worker/src/types.ts and apps/worker/src/engine. They are in sync today,
-- but they are the same drift hazard that silently dropped audit rows for months
-- (#105) and execution-step rows risk before the step_type CHECK was dropped in
-- 20260422000001 — that earlier cleanup removed step_type but left these two
-- siblings on the same high-volume tables. A future status/error_type value
-- added in code without a matching migration would make the engine's
-- waitUntil-fired step/execution writes silently fail the constraint and vanish.
--
-- The typed unions are the single source of truth (and the only writers are the
-- typed step-logger). Drop the checks to remove the silent-drop vector. Config
-- enums (partner_type, service_type, auth_type, bid_*, scope, outcome_state) are
-- left in place — they're admin-set, stable, low-volume, and a bad value there
-- surfaces as a visible error rather than a silent engine data loss.
--
-- Column-scoped introspection so this drops exactly the status/error_type CHECKs
-- regardless of their generated names, and never touches an unrelated CHECK.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT c.conname, t.relname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'c'
      AND t.relname IN ('execution_steps', 'workflow_executions')
      AND pg_get_constraintdef(c.oid) ~ '\m(status|error_type)\M'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', con.relname, con.conname);
  END LOOP;
END $$;
