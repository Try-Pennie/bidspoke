-- scripts/sql-suite/bootstrap.sql: make the throwaway database look like production
-- before the migrations replay onto it (#1409, L714).
--
-- Runs once, as supabase_admin, against the image's `postgres` database. That
-- database and not a fresh one, because pg_cron is preloaded with
-- cron.database_name = postgres and can only be created there, and because the
-- image's `postgres` database already carries the auth schema and the anon,
-- authenticated and service_role roles the migrations reference.
--
-- Default privileges. Production grants new tables in public to anon and
-- authenticated as SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER and
-- MAINTAIN, from BOTH owners (postgres and supabase_admin), measured 2026-09-21.
-- The image grants TRUNCATE too. The difference is removed here so a grant test
-- against this database measures the grant shape production actually has and
-- not a stricter or looser one.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

-- auth.jwt(). The image ships auth.uid(), auth.role() and auth.email() but not
-- auth.jwt(), which migration 20260813000001_is_allowlisted_fn.sql calls
-- (measured 2026-09-21: the replay stopped there, 96 of 140). Production's
-- definition, read with pg_get_functiondef the same day, is reproduced verbatim.
CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

-- Two public objects production holds that NO migration created, measured
-- 2026-09-21 by comparing pg_proc against every CREATE FUNCTION in
-- supabase/migrations. Migrations 20260813000004 and 20260814000002 revoke on
-- them, so a replay from empty stops there without them. Both are reproduced
-- verbatim from production so the replay reaches the end and the resulting
-- database has the same shape as the one the migrations were really applied to.
--
-- 1. The event trigger that enables RLS on every new table in public. Note for
--    anyone writing a migration: production switches RLS on for you, this
--    database now does too, and a migration should still say it explicitly.
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end EXECUTE FUNCTION public.rls_auto_enable();

-- 2. The lead_sightings purge drain, once scheduled by hand through pg_cron.
--    It refers to a table and a schema that migrations create later, which is
--    fine: plpgsql resolves them when the function runs, never here.
CREATE OR REPLACE FUNCTION public.drain_lead_sightings_purge()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  deleted_count int;
begin
  delete from public.lead_sightings
  where id in (
    select id from public.lead_sightings
    where exported_at is not null
      and exported_at < now() - interval '24 hours'
    limit 5000
  );
  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    perform cron.unschedule('drain-lead-sightings-purge');
  end if;
end;
$function$;

-- Replay bookkeeping, outside public so no guard that scans public sees it, and
-- owned by postgres because the replay runs the migrations as postgres, exactly
-- as `supabase db push` does in production.
CREATE SCHEMA IF NOT EXISTS sql_suite;
CREATE TABLE IF NOT EXISTS sql_suite.replayed (
  version    text primary key,
  applied_at timestamptz not null default now()
);
ALTER SCHEMA sql_suite OWNER TO postgres;
ALTER TABLE sql_suite.replayed OWNER TO postgres;
