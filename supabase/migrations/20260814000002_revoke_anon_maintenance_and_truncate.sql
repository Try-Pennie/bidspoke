-- ============================================================
-- Close the anonymous destructive path on maintenance functions (#764, #761)
-- ============================================================
-- Found by the live object assertion added for #764, on its very first run
-- against production (2026-08-14). The repo-side guard for #762 could not see
-- any of this, because it reads migrations and every one of these grants was
-- applied by Postgres and Supabase defaults rather than by a line anyone wrote.
--
-- THE FINDING, measured then re-measured, because the first reading of it was
-- wrong in the direction that overstates:
--
--   1. `anon` could EXECUTE 19 routines in `public`, including the maintenance
--      ones. Confirmed over the public REST API with nothing but the anon key,
--      which is compiled into the client bundle and is therefore public.
--
--   2. `anon` and `authenticated` held INSERT, UPDATE, DELETE, TRUNCATE,
--      REFERENCES and TRIGGER on all 139 tables in `public`, from Supabase's
--      default GRANT ALL to those roles.
--
--   3. Row level security makes the row level grants inert, because no policy
--      admits `anon`. It does NOT make TRUNCATE inert: PostgreSQL does not apply
--      RLS to TRUNCATE, so holding that privilege truncates the whole table
--      regardless of any policy.
--
-- The first conclusion drawn from those three was that an anonymous caller could
-- call `truncate_expired_execution_partitions(0)` over REST and wipe the
-- production execution log. THAT WAS WRONG, and the correction is worth keeping:
--
--   `truncate_expired_execution_partitions` is a PROCEDURE (prokind='p'), and
--   PostgREST does not expose procedures. Measured directly rather than argued:
--   a throwaway function and a throwaway procedure were created with identical
--   anon grants, and the function answered HTTP 200 while the procedure answered
--   404 PGRST202. So the TRUNCATE path was not reachable over HTTP.
--
-- What was genuinely reachable, and is the real reason for this migration:
--
--   * Unauthenticated resource exhaustion. `execution_counts_per_minute` is a
--     FUNCTION, was anon executable, and with a real workflow id it ran until it
--     hit `57014 canceling statement due to statement timeout`. Anyone with the
--     public anon key could burn CPU on the database behind the live bidding
--     engine, repeatedly.
--   * A large excess privilege surface. The other reachable maintenance functions
--     would have failed on their own privileges (DROP needs ownership, DELETE is
--     constrained by RLS), so they were not exploitable, but nothing about that is
--     load bearing or documented. The TRUNCATE grant in particular becomes
--     exploitable through any route to the database as `anon` that is not
--     PostgREST, and it is never legitimately needed by a browser role.
--
-- So: not a data destruction hole, and this migration's comment should not be
-- read as claiming one. A real unauthenticated denial of service, plus privileges
-- nothing needs, both removed below.

-- ── 1. The reachable route: EXECUTE on functions no browser path calls ───────
--
-- Every one of these is called only by the Worker (as `service_role`) or by
-- pg_cron (as the job owner), so removing the browser roles breaks nothing. The
-- trigger functions are included and are safe: PostgreSQL does not check EXECUTE
-- privilege when firing a trigger, only when the trigger is created.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so PUBLIC is revoked
-- as well as the two named roles. Revoking only `anon` and `authenticated` would
-- leave the PUBLIC grant doing the same job (LESSONS L124).
--
-- ON ROUTINE, not ON FUNCTION: three of these are PROCEDUREs (prokind='p'), and
-- `REVOKE ... ON FUNCTION` errors with 42809 "is not a function" on a procedure.
-- ROUTINE covers both, so a future procedure cannot slip past this by kind.

DO $$
DECLARE
  fn RECORD;
  revoked INTEGER := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        -- destructive maintenance
        'truncate_expired_execution_partitions',
        'drop_expired_execution_partitions',
        'drop_expired_execution_partitions_safe',
        'drain_lead_sightings_purge',
        -- schema maintenance
        'create_monthly_analytics_partitions',
        'create_next_month_partitions',
        'create_upcoming_daily_partitions',
        'create_upcoming_daily_partitions_safe',
        'refresh_field_presence_daily',
        'refresh_workflow_stats_daily',
        -- analytics RPCs, Worker only (service_role)
        'workflow_stats_rollup',
        'step_duration_percentiles',
        'step_duration_percentiles_typed',
        'step_duration_percentiles_by_workflow',
        'execution_counts_per_minute',
        'unpaginated_big_tables',
        -- trigger functions, never called directly
        'set_updated_at',
        'folders_prevent_cycle',
        'env_var_folders_prevent_cycle'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO service_role', fn.sig);
    revoked := revoked + 1;
  END LOOP;

  -- Nothing matched would mean this migration silently protected nothing, which
  -- is indistinguishable from success (LESSONS L98). Refuse rather than report a
  -- clean apply.
  IF revoked = 0 THEN
    RAISE EXCEPTION 'revoked EXECUTE on 0 functions, so this migration asserted nothing';
  END IF;
  RAISE NOTICE 'revoked browser-role EXECUTE on % function(s)', revoked;
END
$$;

-- DELIBERATELY LEFT ALONE, each with its reason:
--   public.user_org_id()      28 RLS policies call it, and a policy whose
--                             function the querying role cannot execute ERRORS
--                             rather than denying, so revoking it would break the
--                             app instead of hardening it. It returns only the
--                             caller's own organization from their own JWT, and
--                             an anonymous caller measurably gets null. Same
--                             reasoning as migration 20260813000004.
--   public.is_allowlisted()   The browser calls it on every protected request,
--                             so `authenticated` must keep EXECUTE. `anon` is
--                             already revoked and stays that way.

-- ── 2. The privilege that made it destructive: TRUNCATE ──────────────────────
--
-- The belt to the braces above. TRUNCATE is never legitimately issued by a
-- browser role: the web app reads, and every write path runs in the Worker as
-- `service_role`. Because RLS cannot constrain TRUNCATE, this grant is the one
-- table privilege whose presence is not neutralised by a policy.
--
-- Left in place on purpose: INSERT, UPDATE and DELETE. Those ARE constrained by
-- RLS, no policy admits `anon`, and revoking them wholesale risks a path this
-- migration has not enumerated. They are the wider sweep in #761.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Future tables would otherwise arrive with the same grant, which would make
-- this a one-time cleanup rather than a rule. Supabase's defaults are set for
-- the roles that create objects here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM authenticated;
