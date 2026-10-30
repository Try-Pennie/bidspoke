-- Drop the variables a version kept at its save (#3003), the contract step of
-- #2982 after 20261028200000_ops_version_variables_2702.sql.
--
-- Since #2982 an ops run reads each variable's current value when it starts
-- (Dan's decisions of 2026-10-28 and 29), so what a version kept is read by
-- nothing. The expand half is live: #3044 (deployed 2026-10-30 to the bidding
-- and the ops Worker) stopped the gateway selecting env_capture, and no code in
-- apps, packages or scripts names the column, the trigger or its function.
-- Nothing in pg_depend references the column (no view, index or constraint
-- column list), read in production on 2026-10-30.
--
-- What is lost: measured read only in production on 2026-10-30, 0 of 729
-- versions held a capture other than the column's declared default (null), and
-- no ops lane workflow exists. A capture is a copy of environment_variables
-- rows as they were at a save, which nothing reads.
--
-- Safe before or after the Worker of #3003 deploys: the deployed Worker names
-- none of these. Dropping the trigger only stops a write to a column dropped in
-- the same step. Guarded by supabase/tests/drop_version_env_capture.test.sql.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS capture_version_env_variables ON public.workflow_versions;
DROP FUNCTION IF EXISTS public.capture_version_env_variables();
ALTER TABLE public.workflow_versions DROP COLUMN IF EXISTS env_capture;
