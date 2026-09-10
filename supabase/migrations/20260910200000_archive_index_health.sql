-- Report whether the index the archive's hourly read depends on is intact (#1044).
--
-- WHAT IT PROTECTS. The archive's per-hour count reads `execution_steps` by
-- (execution_started_at, started_at). Without that index the peak-hour count
-- takes 7.1 seconds warm and times out under load, which is the failure #1040
-- fixed. An index is a performance property, so its absence is invisible until
-- a run fails, and by then the archive has already stopped moving.
--
-- TWO WAYS IT GOES MISSING, and one query catches both.
--
-- A migration or hand-run DDL drops or replaces it: the parent index is gone,
-- or present and `indisvalid = false`.
--
-- A partition appears without it. Today's daily partitions are made with
-- CREATE TABLE ... PARTITION OF, which inherits parent indexes automatically,
-- but a partition ATTACHed rather than created does not, and the parent index
-- then silently goes INVALID. Comparing the count of partitions against the
-- count of index partitions attached to the parent index catches that directly,
-- rather than trusting the validity flag alone.
--
-- READ ONLY, and named for a reading rather than an action: this is what a
-- scheduled check calls, and a name that reads like an inspection must never
-- create or modify anything (L206).
--
-- RETURNS ONE ROW ALWAYS. A missing index returning NO rows would be an empty
-- result, and an empty result is what a caller reads as "nothing to report"
-- (L98). The absent case is therefore an explicit row with `index_present`
-- false, so the caller cannot mistake the worst outcome for the healthy one.
CREATE OR REPLACE FUNCTION public.archive_index_health(
  p_parent text DEFAULT 'public.execution_steps',
  p_index text DEFAULT 'idx_exec_steps_execution_started'
)
RETURNS TABLE (
  index_name text,
  index_present boolean,
  index_valid boolean,
  partitions bigint,
  attached bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH parent AS (
    SELECT p_parent::regclass AS oid
  ),
  parts AS (
    SELECT count(*)::bigint AS n
    FROM pg_inherits, parent
    WHERE inhparent = parent.oid
  ),
  idx AS (
    SELECT ci.oid, ci.relname::text AS name, i.indisvalid
    FROM pg_index i
    JOIN pg_class ci ON ci.oid = i.indexrelid
    JOIN parent ON i.indrelid = parent.oid
    WHERE ci.relname = p_index
  )
  SELECT
    p_index AS index_name,
    (SELECT count(*) FROM idx) > 0 AS index_present,
    COALESCE((SELECT indisvalid FROM idx), false) AS index_valid,
    (SELECT n FROM parts) AS partitions,
    COALESCE((SELECT count(*)::bigint FROM pg_inherits WHERE inhparent = (SELECT oid FROM idx)), 0) AS attached;
$$;

COMMENT ON FUNCTION public.archive_index_health(text, text) IS
  'Whether the index the archive read depends on is present, valid, and attached to every partition (#1044). Read only.';

REVOKE ALL ON FUNCTION public.archive_index_health(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_index_health(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.archive_index_health(text, text) TO service_role;
