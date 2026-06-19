-- Big-table guard: also treat STALE stats as suspicious, not just never-analyzed
-- (#242, follow-up to #234).
--
-- #234 added a bounded exact-count fallback only for tables that had NEVER been
-- analyzed (last_analyze IS NULL AND last_autoanalyze IS NULL). Residual gap: a
-- table analyzed once long ago that then grows substantially before autovacuum
-- re-analyzes reads a stale-low reltuples and slips past the threshold for a
-- window — the "treat stale stats as unknown" case #234 flagged.
--
-- Fix: gate the bounded count on PHYSICAL SIZE instead of analyze timestamps.
-- pg_table_size is always current (no ANALYZE needed), so it catches stale AND
-- missing stats uniformly. A heap tuple occupies at least ~24 bytes on disk
-- (23-byte header + alignment), so a table holding >= p_min_rows rows occupies at
-- least p_min_rows * 24 bytes. Any non-partitioned table whose estimate is under
-- the threshold but whose size is large enough to possibly hold p_min_rows rows
-- gets a bounded count(*) (LIMIT p_min_rows, so a huge table is never fully
-- scanned). Tables physically too small to exceed the threshold are skipped with
-- no count, so the daily check stays cheap.

CREATE OR REPLACE FUNCTION unpaginated_big_tables(p_min_rows BIGINT DEFAULT 500)
RETURNS TABLE (
  table_name TEXT,
  est_rows   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  r   RECORD;
  cnt BIGINT;
  -- Hard lower bound on on-disk bytes per heap tuple. Using the minimum (not a
  -- typical row width) keeps the size gate conservative: it never skips a table
  -- that could actually hold p_min_rows rows (no false negatives), it only avoids
  -- counting tables that physically cannot.
  min_bytes_per_row CONSTANT BIGINT := 24;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.reltuples
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'            -- regular tables only
      AND NOT c.relispartition       -- partition children handled by the static guard
  LOOP
    IF r.reltuples >= p_min_rows THEN
      -- Estimate already over the threshold — trust it, no scan needed.
      table_name := r.relname;
      est_rows   := r.reltuples::BIGINT;
      RETURN NEXT;
    ELSIF pg_table_size(r.oid) >= p_min_rows * min_bytes_per_row THEN
      -- Estimate says under threshold, but the table is physically large enough to
      -- possibly hold p_min_rows rows — its stats may be stale or missing, so the
      -- estimate can't be trusted. Bounded count: stops at p_min_rows.
      EXECUTE format(
        'SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT %s) s',
        r.relname, p_min_rows
      ) INTO cnt;
      IF cnt >= p_min_rows THEN
        table_name := r.relname;
        est_rows   := cnt;  -- == p_min_rows, i.e. "at least the threshold"
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION unpaginated_big_tables(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION unpaginated_big_tables(BIGINT) TO service_role;
