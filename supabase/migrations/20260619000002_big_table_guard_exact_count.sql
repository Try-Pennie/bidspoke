-- Big-table guard: exact-count fallback for never-analyzed tables (#234).
--
-- unpaginated_big_tables (20260618000001) filtered on pg_class.reltuples, an
-- estimate the planner only refreshes on ANALYZE/autovacuum. A freshly created,
-- bulk-loaded, not-yet-analyzed table reads as ~0 rows (reltuples is -1 when a
-- table has never been analyzed) and slips past the threshold — exactly the
-- "silently grew past the 1,000-row cap" case this guard exists to catch.
--
-- Fix: keep the cheap estimate path for tables with usable stats, but for tables
-- whose stats are unreliable (never analyzed) yet which physically hold data
-- (pg_table_size > 0), fall back to a BOUNDED count(*) — `LIMIT p_min_rows` so a
-- genuinely huge table is never fully scanned (the count stops at the threshold).
-- Only the suspicious-and-non-empty tables ever get counted, so the daily check
-- stays cheap.

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
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.reltuples,
           st.last_analyze, st.last_autoanalyze
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'            -- regular tables only
      AND NOT c.relispartition       -- partition children handled by the static guard
  LOOP
    IF r.reltuples >= p_min_rows THEN
      -- Estimate already over the threshold — trust it, no scan needed.
      table_name := r.relname;
      est_rows   := r.reltuples::BIGINT;
      RETURN NEXT;
    ELSIF r.last_analyze IS NULL
      AND r.last_autoanalyze IS NULL
      AND pg_table_size(r.oid) > 0 THEN
      -- Stats are unreliable (table never analyzed) but it holds data, so the
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
