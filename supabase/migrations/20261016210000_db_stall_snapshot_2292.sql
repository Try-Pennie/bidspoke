-- ============================================================
-- A snapshot of what the database is doing, taken during a write stall (#2292)
-- ============================================================
-- Writes to workflow_executions, lead_sightings and execution_steps stalled for
-- minutes three times on 2026-10-16 (12:55 to 13:02, 17:30, 18:30 to 18:41 UTC)
-- and served leads lost their records. Afterwards disk, CPU, memory, lock waits,
-- pg_cron, deploys and connection counts were all ruled out, and nothing had
-- recorded what each backend was doing at the time, so the cause could not be
-- found after the fact.
--
-- The Worker calls this function the moment one of its post-response writes
-- times out (lib/db-stall-snapshot.ts), at most once every two minutes, and
-- keeps the answer in KV for three days beside the slowdown alert. It returns
-- one bounded jsonb document:
--   backends        each non-idle backend, longest running first, at most 100:
--                   who (usename, application_name, client_addr, backend_type),
--                   what it is waiting on (state, wait_event_type, wait_event),
--                   since when (xact_start, query_start, state_change), and the
--                   first 300 characters of its query
--   blocking        each backend waiting on another, at most 50: who blocks it
--                   (pg_blocking_pids) and the lock it waits for
--   by_state        every backend counted by state, idle ones included
--   by_client       the same counts by role and application, at most 30 rows,
--                   so a saturated PostgREST pool shows as its own row
--   max_connections and total_backends, for the same question
-- It reads only catalogue views: it changes nothing and takes no lock beyond
-- what pg_blocking_pids needs to read the lock table.
--
-- Query text can carry customer data. It is cut to 300 characters here, the
-- Worker cuts it again before storing it, and it is never sent to Slack.
--
-- SECURITY: SECURITY DEFINER so the function reads every backend's query, which
-- only a member of pg_read_all_stats may (measured 2026-10-16: the owner,
-- postgres, is one on the bidding project). Postgres grants EXECUTE on a new
-- function to PUBLIC by default, so without the REVOKEs below anyone with the
-- publishable key could read every running query (#762). service_role only.

CREATE OR REPLACE FUNCTION public.db_stall_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH act AS (
    SELECT a.*
    FROM pg_stat_activity a
    WHERE a.pid <> pg_backend_pid()
  ),
  busy AS (
    SELECT
      a.pid,
      a.usename::text AS usename,
      a.application_name,
      host(a.client_addr) AS client_addr,
      a.backend_type,
      a.state,
      a.wait_event_type,
      a.wait_event,
      a.xact_start,
      a.query_start,
      a.state_change,
      left(a.query, 300) AS query
    FROM act a
    WHERE a.state IS DISTINCT FROM 'idle'
  ),
  busy_shown AS (
    SELECT * FROM busy
    ORDER BY coalesce(xact_start, query_start) ASC NULLS LAST, pid
    LIMIT 100
  ),
  blocked AS (
    SELECT
      a.pid,
      bp.pids AS blocked_by,
      l.locktype,
      l.mode,
      l.relation::regclass::text AS relation,
      extract(epoch FROM (clock_timestamp() - a.state_change))::numeric(12, 3) AS waiting_seconds
    FROM act a
    CROSS JOIN LATERAL (SELECT pg_blocking_pids(a.pid) AS pids) bp
    LEFT JOIN LATERAL (
      SELECT pl.locktype, pl.mode, pl.relation
      FROM pg_locks pl
      WHERE pl.pid = a.pid AND NOT pl.granted
      LIMIT 1
    ) l ON true
    WHERE cardinality(bp.pids) > 0
    ORDER BY a.state_change ASC NULLS LAST, a.pid
    LIMIT 50
  ),
  by_state AS (
    SELECT coalesce(state, '(none)') AS state, count(*) AS count
    FROM act
    GROUP BY 1
  ),
  by_client AS (
    SELECT
      coalesce(usename::text, '(none)') AS usename,
      coalesce(nullif(application_name, ''), '(none)') AS application_name,
      coalesce(state, '(none)') AS state,
      count(*) AS count
    FROM act
    GROUP BY 1, 2, 3
    ORDER BY count(*) DESC, 1, 2, 3
    LIMIT 30
  )
  SELECT jsonb_build_object(
    'taken_at', clock_timestamp(),
    'max_connections', current_setting('max_connections')::int,
    'total_backends', (SELECT count(*) FROM act),
    'backends_total', (SELECT count(*) FROM busy),
    'backends_shown', (SELECT count(*) FROM busy_shown),
    'backends', coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY coalesce(b.xact_start, b.query_start) ASC NULLS LAST, b.pid) FROM busy_shown b), '[]'::jsonb),
    'blocking', coalesce((SELECT jsonb_agg(to_jsonb(k) ORDER BY k.pid) FROM blocked k), '[]'::jsonb),
    'by_state', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.count DESC, s.state) FROM by_state s), '[]'::jsonb),
    'by_client', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.count DESC, c.usename, c.application_name, c.state) FROM by_client c), '[]'::jsonb)
  );
$$;

-- The lines that matter: without them, anyone with the publishable key reads
-- every running query.
REVOKE ALL ON FUNCTION public.db_stall_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.db_stall_snapshot() FROM anon;
REVOKE ALL ON FUNCTION public.db_stall_snapshot() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.db_stall_snapshot() TO service_role;

COMMENT ON FUNCTION public.db_stall_snapshot() IS
  'What every backend is doing, bounded, for the Worker to keep when a post-response write stalls (#2292). Query text cut to 300 characters. service_role only.';
