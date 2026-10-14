-- The file parser monitor's tables under the ops rules (#2068).
--
-- parser_runs and parser_registry were created by hand on the live ops project on
-- 2026-10-13, outside any migration, with row level security off and no
-- organization_id, so the live privilege check failed on every push to main from
-- then on. Measured 2026-10-14: parser_runs held 28 runs, the newest that
-- afternoon, and parser_registry 15 parsers, so something still writes them. Only
-- postgres and service_role hold grants, so that writer is the service role, which
-- row level security does not restrict: turning it on stops no current reader or
-- writer.
--
-- The writer inserts without naming an organization, so organization_id arrives
-- with Pennie's organization (trypennie.com in the bidding project) as its default,
-- which also fills the rows already there. A NOT NULL column with no default would
-- fail the writer's next insert.
--
-- CREATE TABLE IF NOT EXISTS reproduces the live shape as it was measured, so a
-- database built from empty (the SQL suite, a restore) has the tables too; on the
-- live project it does nothing and the statements after it bring the existing
-- tables into line. Additive throughout (ADR 0007).
--
-- Guarded by supabase-ops/supabase/tests/parser_tables.test.sql.

CREATE TABLE IF NOT EXISTS public.parser_registry (
  parser       text PRIMARY KEY,
  label        text NOT NULL,
  cadence      text NOT NULL,
  expected_by  time NOT NULL,
  expected_day integer,
  workflow_url text,
  source       text,
  active       boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.parser_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parser         text NOT NULL,
  run_at         timestamptz NOT NULL,
  status         text NOT NULL,
  dry_run        boolean DEFAULT false,
  blocked        boolean DEFAULT false,
  file_name      text,
  file_date      date,
  jobs_submitted text[] DEFAULT '{}'::text[],
  violations     jsonb DEFAULT '[]'::jsonb,
  warnings       jsonb DEFAULT '[]'::jsonb,
  anomalies      jsonb DEFAULT '[]'::jsonb,
  envelope       jsonb NOT NULL,
  received_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parser_runs_parser_run_at_idx ON public.parser_runs (parser, run_at DESC);
CREATE INDEX IF NOT EXISTS parser_runs_status_idx ON public.parser_runs (status) WHERE status <> 'ok';

ALTER TABLE public.parser_registry
  ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL DEFAULT '9d9d0d3a-1959-41d5-95ca-c1399fa54590';
ALTER TABLE public.parser_runs
  ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL DEFAULT '9d9d0d3a-1959-41d5-95ca-c1399fa54590';

ALTER TABLE public.parser_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parser_runs ENABLE ROW LEVEL SECURITY;

-- The default privileges the first migration revoked already keep the browser
-- roles out of tables made after it; revoked again by name, since these two were
-- made by hand and their grants were never a migration's.
REVOKE ALL ON public.parser_registry, public.parser_runs FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parser_registry, public.parser_runs TO service_role;
