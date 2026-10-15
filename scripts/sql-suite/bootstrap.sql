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

-- auth.uid(). The image's version reads only request.jwt.claim.sub, while
-- production's (read with pg_get_functiondef on 2026-10-15, reproduced verbatim)
-- falls back to the sub inside request.jwt.claims, which is how a request carries
-- it today. A policy calling user_org_id() for a caller set up the way production
-- sets one up therefore saw no user here (#2131).
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
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

-- The realtime schema (#2131). On the hosted platform the Realtime service
-- creates and owns realtime.messages, realtime.send and realtime.topic(); the
-- image ships only an empty `realtime` schema, so a migration adding a policy on
-- realtime.messages, or a trigger calling realtime.send, could not replay here.
-- What follows reproduces production as read on 2026-10-15: the table's columns,
-- primary key, check and RANGE partitioning on inserted_at, its owner
-- supabase_realtime_admin (postgres is NOT a member there, so a migration's
-- CREATE POLICY works only through supautils.policy_grants, which this image
-- configures the same way), its row level security and grants, and send and
-- topic() verbatim from pg_get_functiondef.
--
-- THIS PROVES THE SQL, NOT THE PLATFORM. Nothing here delivers a message; only
-- the live spike (scripts/realtime-spike/run.mjs) can say whether Realtime does.
--
-- No partition is created: production keeps only the days Realtime itself makes
-- (none after 2026-10-02 when measured, while nothing was connected), so a test
-- makes the day it needs with sql_suite.create_realtime_partition, and a send
-- with none fails the way it does in production, as a WARNING that stores nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin NOLOGIN NOINHERIT;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS realtime;
GRANT USAGE, CREATE ON SCHEMA realtime TO supabase_realtime_admin;
GRANT USAGE ON SCHEMA realtime TO postgres, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS realtime.messages (
  topic          text NOT NULL,
  extension      text NOT NULL,
  payload        jsonb,
  event          text,
  private        boolean DEFAULT false,
  updated_at     timestamp without time zone NOT NULL DEFAULT now(),
  inserted_at    timestamp without time zone NOT NULL DEFAULT now(),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  binary_payload bytea,
  skip_broadcast boolean NOT NULL DEFAULT false,
  CONSTRAINT messages_pkey PRIMARY KEY (id, inserted_at),
  CONSTRAINT messages_payload_exclusive CHECK ((payload IS NULL) OR (binary_payload IS NULL))
) PARTITION BY RANGE (inserted_at);
ALTER TABLE realtime.messages OWNER TO supabase_realtime_admin;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON realtime.messages TO postgres;
GRANT INSERT, SELECT, UPDATE ON realtime.messages TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION realtime.topic()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
select nullif(current_setting('realtime.topic', true), '')::text;
$function$;

CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();

    -- Check if payload has an 'id' key, if not, add the generated UUID
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;

    -- Set the topic configuration
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$function$;
ALTER FUNCTION realtime.topic() OWNER TO supabase_realtime_admin;
ALTER FUNCTION realtime.send(jsonb, text, text, boolean) OWNER TO supabase_realtime_admin;
GRANT EXECUTE ON FUNCTION realtime.topic() TO PUBLIC;
GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO PUBLIC;

-- Makes the realtime.messages partition for one day, as the Realtime service
-- would. Test plumbing only, in sql_suite and not in realtime, owned by the
-- superuser because postgres cannot create a partition of a table it does not
-- own. A test calling it inside a transaction it rolls back leaves nothing.
CREATE OR REPLACE FUNCTION sql_suite.create_realtime_partition(p_day date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_name text := 'messages_' || to_char(p_day, 'YYYY_MM_DD');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS realtime.%I PARTITION OF realtime.messages FOR VALUES FROM (%L) TO (%L)',
    v_name, p_day::timestamp, (p_day + 1)::timestamp
  );
  EXECUTE format('ALTER TABLE realtime.%I OWNER TO supabase_realtime_admin', v_name);
END;
$function$;
REVOKE ALL ON FUNCTION sql_suite.create_realtime_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sql_suite.create_realtime_partition(date) TO postgres;
