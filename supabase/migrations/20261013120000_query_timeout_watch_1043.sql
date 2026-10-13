-- ============================================================
-- Warn when a query approaches the statement timeout (#1043, milestone 49)
-- ============================================================
-- Postgres cancels a statement at its role's statement_timeout with a 57014 and
-- no signal before that. The archive's steps count ran 7.1s warm for weeks, then
-- one run took 30.2s and was cancelled (#1040): nothing between "fine" and
-- "outage". The ceiling is per ROLE, not one number (measured 2026-10-13 in
-- pg_db_role_setting): service_role 30s (the Worker), authenticated and
-- authenticator 8s (the browser), anon 3s. `postgres` runs the SQL editor at 120s
-- and is deliberately NOT returned here: its stats mix the dashboard's and the
-- migration tool's ad-hoc queries with pg_cron, so a 100s SQL-editor query would
-- read as an app query one run from the cliff. pg_cron's own budgets are watched
-- through cron.job_run_details (pg_cron_health, #770) and set explicitly (#1149).
--
-- pg_stat_statements already records each statement's mean and max execution time
-- per role, with every constant normalised to `$1`, so no literal value (and no
-- PII) leaves the database. The Worker reads through this function rather than the
-- extension directly, for two reasons: the `extensions` schema is not exposed to
-- PostgREST, and the function joins each statement to its role's ceiling, which is
-- the whole point and is awkward to do from the client.
--
-- SECURITY: Postgres grants EXECUTE on a new function to PUBLIC by default, so a
-- SECURITY DEFINER function is callable by `anon` over the REST API unless that
-- grant is removed (that was #762). The REVOKE below is the load-bearing line: a
-- listing of the slowest statements and their shapes is service_role only.

CREATE OR REPLACE FUNCTION public.query_timeout_watch(p_min_calls integer DEFAULT 20)
RETURNS TABLE (
  role         text,
  -- text, not bigint: PostgREST serialises a bigint as a JSON number, and a
  -- queryid is an int64 that routinely exceeds 2^53, so JSON.parse in the client
  -- would round it before any code saw it, and a corrupted id cannot be looked up
  -- in pg_stat_statements. Returned as text, it survives intact (L11, L50).
  queryid      text,
  calls        bigint,
  mean_ms      double precision,
  max_ms       double precision,
  timeout_ms   double precision,
  query_sample text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- plpgsql, so `extensions.pg_stat_statements` is resolved when the function RUNS,
-- not when it is created: the throwaway SQL-suite database replays this migration
-- without the extension installed, and a LANGUAGE sql body would fail to create
-- there. The guard below then returns cleanly when it is absent.
SET search_path = pg_catalog, extensions, public
AS $$
DECLARE
  -- The API roles, each judged against its own ceiling. `postgres` is excluded on
  -- purpose (see the header): its stats are the SQL editor and pg_cron, not the app.
  watched text[] := array['service_role', 'authenticated', 'authenticator', 'anon'];
  min_calls bigint := greatest(coalesce(p_min_calls, 20), 1);
BEGIN
  -- pg_stat_statements absent (the SQL-suite container) means nothing to measure,
  -- which is an empty result, not an error (L98 is about a READ failing; a
  -- deliberately-empty platform is not that).
  IF to_regclass('extensions.pg_stat_statements') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH role_timeout AS (
    -- ONE ceiling per role. pg_db_role_setting can hold several rows per role: a
    -- cluster-wide default (setdatabase = 0) and a per-database override. Take only
    -- those two and, with DISTINCT ON, prefer the per-database override when it
    -- exists, so the role is not duplicated (which would duplicate every statement
    -- joined to it).
    SELECT DISTINCT ON (r.oid)
      r.oid AS userid,
      r.rolname::text AS rolname,
      -- statement_timeout is stored as its GUC string with a unit: '30s', '8s',
      -- '500ms', '2min', '1h', or a bare number which Postgres reads as ms. Parse
      -- the number and the unit and convert to ms. A unit outside this set yields
      -- NULL, which the WHERE below drops, rather than being read as a bare ms and
      -- making the ceiling absurdly small (a '1h' read as 1ms) (L50).
      CASE t.unit
        WHEN 'us'  THEN t.n / 1000
        WHEN 'ms'  THEN t.n
        WHEN 's'   THEN t.n * 1000
        WHEN 'min' THEN t.n * 60000
        WHEN 'h'   THEN t.n * 3600000
        WHEN 'd'   THEN t.n * 86400000
        WHEN ''    THEN t.n           -- bare number: Postgres treats it as ms
        ELSE NULL
      END AS timeout_ms
    FROM pg_roles r
    JOIN pg_db_role_setting s
      ON s.setrole = r.oid
     AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
     -- Only rows that actually set statement_timeout. A role can have a per-database row that
     -- overrides some OTHER setting (search_path, say); such a row carries no timeout, and
     -- because its setdatabase is higher the DISTINCT ON below would otherwise pick it and
     -- drop the role entirely (its timeout would be NULL). Filtering here leaves DISTINCT ON
     -- choosing between rows that each carry a timeout.
     AND array_to_string(s.setconfig, ',') ILIKE '%statement_timeout=%'
    CROSS JOIN LATERAL (
      SELECT
        (m[1])::numeric AS n,
        coalesce(m[2], '') AS unit
      FROM regexp_match(array_to_string(s.setconfig, ','), 'statement_timeout=([0-9.]+)\s*(us|ms|s|min|h|d)?') AS m
    ) t
    WHERE r.rolname = ANY(watched)
    ORDER BY r.oid, s.setdatabase DESC   -- per-database override (oid > 0) before the role-wide default (0)
  ),
  stmt AS (
    -- ONE row per (role, statement). pg_stat_statements holds a row per
    -- (userid, dbid, queryid, toplevel), so the same statement appears more than
    -- once (top level and nested, and across databases). Scope to this database and
    -- collapse to one row: total calls, the worst single run, and a calls-weighted
    -- mean, so a statement is neither double counted nor double reported.
    SELECT
      st.userid,
      st.queryid,
      sum(st.calls)::bigint AS calls,
      max(st.max_exec_time) AS max_ms,
      sum(st.mean_exec_time * st.calls) / nullif(sum(st.calls), 0) AS mean_ms,
      (array_agg(st.query ORDER BY st.calls DESC))[1] AS query
    FROM extensions.pg_stat_statements st
    WHERE st.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    GROUP BY st.userid, st.queryid
  )
  SELECT
    rt.rolname,
    s.queryid::text,
    s.calls,
    s.mean_ms,
    s.max_ms,
    rt.timeout_ms::double precision,
    left(regexp_replace(s.query, '\s+', ' ', 'g'), 200)::text
  FROM role_timeout rt
  JOIN stmt s ON s.userid = rt.userid
  WHERE rt.timeout_ms IS NOT NULL
    AND rt.timeout_ms > 0
    AND s.calls >= min_calls
  -- Closest to its ceiling first, bounded so this is never the row-cap trap #115.
  ORDER BY (s.max_ms / rt.timeout_ms) DESC
  LIMIT 50;
END;
$$;

-- The line that matters: without it, anyone with the publishable key can read the
-- slowest statements and their shapes.
REVOKE ALL ON FUNCTION public.query_timeout_watch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.query_timeout_watch(integer) FROM anon;
REVOKE ALL ON FUNCTION public.query_timeout_watch(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.query_timeout_watch(integer) TO service_role;

COMMENT ON FUNCTION public.query_timeout_watch(integer) IS
  'The slowest statements per API role as a fraction of that role''s statement_timeout, from pg_stat_statements, for the Worker''s query-timeout watch (#1043). service_role only.';
