-- The lane a workflow runs in (#1707, Phase 0 part 0.C of milestone 56).
--
-- money: sells leads, runs on the bidding Worker (bidspoke-worker). Every
-- workflow that exists today is one.
-- ops: internal tooling moved off Pipedream, which will run on the ops Worker
-- against its own database (plan 0.E). None exists yet.
--
-- The engine reads this through the definition loader at every entry point and
-- refuses a workflow stored under a lane the Worker does not serve, before
-- anything is recorded. The CHECK keeps the stored value to the two the engine
-- knows, and the loader also refuses any other value by name rather than guess.
--
-- Expand only (ADR 0007): a new NOT NULL column with a constant default fills
-- every existing row with 'money' without rewriting the table, and the code
-- deployed before #1707 never selects it, so applying this first is safe. The
-- order is NOT free the other way: the #1707 loader selects the column on every
-- cache miss, so this must be applied BEFORE that code deploys (it was, on
-- 2026-10-02, ahead of the merge). The lock_timeout keeps the brief ACCESS EXCLUSIVE lock from
-- queueing every webhook's cache miss behind a long running transaction; if it
-- cannot be taken in time the statement fails and is simply run again.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.workflows
  ADD COLUMN lane text NOT NULL DEFAULT 'money'
  CONSTRAINT workflows_lane_check CHECK (lane IN ('money', 'ops'));

COMMENT ON COLUMN public.workflows.lane IS
  'Which Worker runs this workflow: money (the bidding Worker) or ops (the ops Worker). Read at every entry point; a workflow on the wrong Worker is refused before anything is recorded (#1707).';
