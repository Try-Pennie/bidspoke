-- Runtime guard for the "unpaginated big table" bug (#222).
--
-- The static guard (apps/web/src/lib/__tests__/worker-big-table-pagination.test.ts)
-- only auto-detects PARTITIONED tables declared in migrations. A non-partitioned
-- table that simply grows past PostgREST's 1,000-row list cap (persons, audit_log
-- both did) isn't caught until a human remembers to add it to BIG_TABLES. This
-- function lets a daily worker check spot such tables from live row estimates, so
-- they can be paginated + listed before unbounded reads start truncating.
--
-- Returns non-partitioned regular tables in `public` whose estimated row count
-- (pg_class.reltuples, kept current by autovacuum/ANALYZE) is at least p_min_rows.
-- Excludes partitioned parents (relkind 'p') and partition children
-- (relispartition) — those are covered by the partition-aware static guard.

CREATE OR REPLACE FUNCTION unpaginated_big_tables(p_min_rows BIGINT DEFAULT 500)
RETURNS TABLE (
  table_name TEXT,
  est_rows   BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT c.relname::TEXT, GREATEST(c.reltuples, 0)::BIGINT AS est_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relispartition
    AND c.reltuples >= p_min_rows
  ORDER BY c.reltuples DESC
$$;

GRANT EXECUTE ON FUNCTION unpaginated_big_tables(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION unpaginated_big_tables(BIGINT) TO service_role;
