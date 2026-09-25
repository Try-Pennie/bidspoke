-- Every cleanup query has an index to use (#467).
--
-- WHY. On 2026-07-01 the sightings purge's row-finding query (exported_at IS NOT
-- NULL AND exported_at < cutoff) had no matching index and sequentially scanned
-- every partition until it hit the statement timeout (57014). The Worker's unit
-- tests could not see it, because they mock Supabase: a seq scan and a timeout do
-- not exist in a mock. The index was added by 20260701000001_export_purge_indexes,
-- and nothing stopped a later migration dropping it, or a new buffer table
-- arriving without one.
--
-- HOW. Each cleanup predicate is planned with sequential scans disabled. When a
-- partition has an index the predicate can use, the planner seeks on it; when it
-- has none, it still has to read the partition whole, either as a "Seq Scan" or
-- by walking an unrelated index end to end. Every scan node must therefore carry
-- an index condition on the predicate's own column. Empty partitions plan the
-- same way, so this works on the throwaway database with no rows.
--
-- WHICH TABLES. Derived from the catalogue, never listed: every partitioned
-- table in public with an exported_at column is a buffer the purge drains, so a
-- new one is checked the day it is created (L96). The count is asserted too, so
-- a query that found no tables cannot pass (L215).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

CREATE TEMP TABLE IF NOT EXISTS index_cases (name text PRIMARY KEY);
DELETE FROM index_cases;

-- Fails unless every scan in the plan SEEKS on p_col. Two ways a partition can
-- still be read whole with seq scans disabled, and both are refused: a "Seq Scan"
-- node (no index at all), and an index scan whose Index Cond does not constrain
-- p_col (the planner walking some other index, for example the primary key, end
-- to end, which is just as slow and was seen passing an earlier version of this
-- check when the sandbox index was dropped).
CREATE OR REPLACE FUNCTION pg_temp.assert_indexed(p_label text, p_sql text, p_col text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_plan jsonb;
  v_node jsonb;
  v_bad  text[] := '{}';
  v_scans int := 0;
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  EXECUTE 'EXPLAIN (FORMAT JSON) ' || p_sql INTO v_plan;
  FOR v_node IN SELECT jsonb_path_query(v_plan, 'strict $.**') AS n LOOP
    CONTINUE WHEN jsonb_typeof(v_node) <> 'object' OR NOT (v_node ? 'Node Type');
    IF v_node->>'Node Type' = 'Seq Scan' THEN
      v_scans := v_scans + 1;
      v_bad := array_append(v_bad, (v_node->>'Relation Name') || ' (seq scan)');
    ELSIF v_node->>'Node Type' IN ('Index Scan', 'Index Only Scan', 'Bitmap Index Scan') THEN
      v_scans := v_scans + 1;
      IF coalesce(v_node->>'Index Cond', '') NOT LIKE '%' || p_col || '%' THEN
        v_bad := array_append(v_bad, coalesce(v_node->>'Relation Name', v_node->>'Index Name') || ' (' || (v_node->>'Index Name') || ' without a condition on ' || p_col || ')');
      END IF;
    END IF;
  END LOOP;
  -- A plan with no scan at all measured nothing (L98).
  IF v_scans = 0 THEN RAISE EXCEPTION '% planned no scan at all: %', p_label, v_plan; END IF;
  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION '% has no usable index on: % (query: %)', p_label, array_to_string(v_bad, ', '), p_sql;
  END IF;
END;
$$;

-- ── 1. The buffer tables are found, so the checks below cannot pass empty ────
DO $do$
DECLARE
  v_tables text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'p'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'exported_at' AND NOT a.attisdropped);
  -- NULL when nothing matched, and NOT NULL is NULL, which IF reads as false: so an
  -- empty catalogue must be refused on its own, or this passes on finding nothing.
  IF v_tables IS NULL OR NOT (v_tables @> ARRAY['achieve_evaluations', 'lead_sighting_bids', 'lead_sightings']) THEN
    RAISE EXCEPTION 'the buffer tables were not all found: %', v_tables;
  END IF;
  INSERT INTO index_cases(name) VALUES ('buffer tables found');
END
$do$;

-- ── 2. The purge's row-finding query, in both shapes it has been run in ──────
DO $do$
DECLARE
  v_table text;
BEGIN
  FOR v_table IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'p'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'exported_at' AND NOT a.attisdropped)
  LOOP
    -- The Worker's page (purgeOldExported, before #541): any 200 purgeable rows.
    PERFORM pg_temp.assert_indexed(v_table || ' purge page',
      format('SELECT id FROM public.%I WHERE exported_at IS NOT NULL AND exported_at < now() - interval ''24 hours'' LIMIT 200', v_table),
      'exported_at');
    -- The database purge's page (#541): the oldest exported first.
    PERFORM pg_temp.assert_indexed(v_table || ' purge page, oldest first',
      format('SELECT id FROM public.%I WHERE exported_at IS NOT NULL AND exported_at < now() - interval ''24 hours'' ORDER BY exported_at LIMIT 5000', v_table),
      'exported_at');
  END LOOP;
  INSERT INTO index_cases(name) VALUES ('purge predicate indexed on every buffer table');
END
$do$;

-- ── 3. The Achieve sandbox purge, which keys on is_sandbox and its partition key
DO $do$
BEGIN
  PERFORM pg_temp.assert_indexed('achieve_evaluations sandbox purge page',
    'SELECT id FROM public.achieve_evaluations WHERE is_sandbox = true AND requested_at_utc < now() - interval ''7 days'' LIMIT 200',
    'is_sandbox');
  INSERT INTO index_cases(name) VALUES ('sandbox purge indexed');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM index_cases);
BEGIN
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
