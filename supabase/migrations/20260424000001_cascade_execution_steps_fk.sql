-- Make execution_steps → workflow_executions FK cascade on delete.
-- Previously RESTRICT, which forced a two-step delete (steps first, then executions)
-- for ad-hoc pruning. Steps have no meaning without their execution, so cascade
-- is the correct semantic. Workflow-level safety is still enforced by the
-- workflow_executions → workflows FK (RESTRICT), which preserves soft-delete history.
--
-- REWRITTEN 2026-09-03 TO BE REPLAYABLE. This migration has never been able to run
-- on a fresh database.
--
-- WHAT THAT DOES AND DOES NOT COST US, checked against the runbook rather than
-- assumed. It does NOT break disaster recovery: `docs/disaster-recovery.md`
-- Scenario A restores from a dump in every case, including total project loss, and
-- then applies only PENDING migrations, so recovery never replays this directory
-- from empty. What it breaks is every attempt to stand a FRESH database up from the
-- repo: a Supabase preview branch, a staging project, a local stack, a database in
-- CI. All of them stop at 22 of 119.
--
-- That has a compounding cost worth naming, because it is why this was found so
-- late. With no way to create a working empty database, nothing in this repo has
-- ever been tested against real Postgres: every SQL guard reads migration TEXT
-- instead of executing it. The deletion gate in `20260903210000` needed a real
-- database to test the procedures that empty a partition, which is what led here.
--
-- It used to open with `DROP CONSTRAINT execution_steps_execution_fk`, a name that
-- appears nowhere earlier in the history. `20260402000002_core_tables.sql` declares
-- the foreign key INLINE and UNNAMED inside `CREATE TABLE execution_steps`, so
-- Postgres names it `execution_steps_execution_id_execution_started_at_fkey`. The
-- name this migration dropped only ever existed in production, where somebody must
-- have created it by hand. So on any fresh database the first statement raised
-- `42704 constraint "execution_steps_execution_fk" of relation "execution_steps"
-- does not exist` and the remaining 96 migrations never ran.
--
-- Measured 2026-09-03 on two independent throwaway Supabase branches: both applied
-- 22 of 119 migrations and both stopped here, and the statement was run by hand on
-- one of them to capture the error above rather than infer it.
--
-- WHY EDITING AN ALREADY APPLIED MIGRATION IS RIGHT HERE. Normally history is
-- immutable. This edit is inert in production, which recorded this version as
-- applied months ago and will never re-run it, and the alternative is a directory
-- that cannot be replayed, which makes the recovery runbook fiction. The end state
-- is unchanged in both directions.
--
-- IT DROPS BY LOOKUP, NOT BY NAME, which is the point: the name is exactly what was
-- wrong. Measured on the fresh branch, `execution_steps` carries thirteen
-- `pg_constraint` foreign key rows, but only ONE of them owns anything
-- (`conparentid = 0`); the other twelve are rows Postgres derives from it, one per
-- partition of `execution_steps` and one per referenced partition of
-- `workflow_executions`. Dropping the owner takes all twelve with it, so the loop
-- runs once in practice. It is a loop rather than a single statement so that a
-- schema which one day carries two owning keys here does not leave one behind.
--
-- The end state was verified rather than assumed: after this migration a fresh
-- database holds exactly one owning key, named `execution_steps_execution_fk`, with
-- ON DELETE CASCADE and twelve derived rows. `20260619000001` then drops it by that
-- name, leaving zero, which is what production holds today (verified 2026-09-03).
-- Getting that convergence right is not cosmetic: TRUNCATE refuses a table that a
-- foreign key references, and enabling TRUNCATE is the entire purpose of
-- `20260619000001`, so a leftover key would fail the nightly purge on a recovered
-- database and nowhere else.

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  LOOP
    SELECT c.conname INTO v_conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.execution_steps'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.workflow_executions'::regclass
    LIMIT 1;

    EXIT WHEN v_conname IS NULL;

    -- Dropping the parent's constraint can take its per-partition rows with it,
    -- so the list is re-read each time round rather than collected up front.
    EXECUTE format('ALTER TABLE public.execution_steps DROP CONSTRAINT %I', v_conname);
  END LOOP;
END $$;

ALTER TABLE execution_steps
  ADD CONSTRAINT execution_steps_execution_fk
  FOREIGN KEY (execution_id, execution_started_at)
  REFERENCES workflow_executions(id, started_at)
  ON DELETE CASCADE;
