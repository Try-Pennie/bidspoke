-- Let the Worker read the retention window the purge jobs are ACTUALLY scheduled
-- at, so a hand change to either job can be compared against the code (#1017).
--
-- WHY THIS IS NOT COVERED ALREADY. Two guards exist now and neither sees this
-- case. `archive-retention-matches-purge.test.ts` compares the code against the
-- MIGRATIONS, which catches a recorded change before it merges but cannot see a
-- job edited directly in the database. The deletion gate catches the dangerous
-- direction at runtime by accident: retention SHORTER than the code believes
-- makes days vanish from Postgres while the archive still holds them, which
-- refuses as `executions-surplus`. The milder direction, jobs kept LONGER than
-- the code thinks, has no runtime symptom at all, and that is the one that
-- happened: from 2026-08-24 to 2026-09-03 the jobs ran at 21 days while the code
-- said 7, and the gate told the team a day was one night from deletion when it
-- had fifteen.
--
-- NARROW ON PURPOSE. It returns the two named purge jobs and nothing else, rather
-- than exposing `cron.job` to the service role. An over-broad grant is invisible,
-- because the code never attempts what it is not meant to do, while a missing one
-- fails loudly on the first run (L503). `pg_cron_health` already returns jobname,
-- schedule and active for every job and deliberately does NOT return `command`,
-- so widening it would hand every job's command to a caller that needs two.
--
-- KEYED ON NAME, NEVER `jobid`. Both jobs have already been recreated once: #1013
-- records them as jobids 20 and 21, and they are 41 and 42 today, because
-- `cron.schedule` on an existing name is an unschedule plus a schedule. A check
-- keyed on the id would have gone blind at the moment somebody rebuilt the thing
-- it watches (L15).
--
-- The retention argument is returned UNPARSED as well as parsed. A command whose
-- number cannot be read is a different finding from one that disagrees, and the
-- caller can only tell them apart, or quote what it saw, if it has the text
-- (L11).

CREATE OR REPLACE FUNCTION public.execution_purge_retention()
  RETURNS TABLE(jobname text, active boolean, retention_days integer, command text)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public', 'cron', 'pg_temp'
AS $function$
  SELECT
    j.jobname::text,
    j.active,
    -- The first integer literal in the command's argument list, e.g.
    -- `CALL truncate_expired_execution_partitions(21)` -> 21. NULL when there is
    -- no such literal, which the caller reports as unreadable rather than
    -- treating as a number it does not have.
    NULLIF(regexp_replace(j.command, '^[^(]*\(\s*(\d+)\s*\).*$', '\1'), j.command)::integer,
    j.command::text
  FROM cron.job j
  WHERE j.jobname IN ('purge-old-execution-partitions', 'reap-empty-execution-partitions');
$function$;

-- The Worker connects as service_role. anon and authenticated have no business
-- reading the schedule on which production data is destroyed.
REVOKE ALL ON FUNCTION public.execution_purge_retention() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execution_purge_retention() FROM anon;
REVOKE ALL ON FUNCTION public.execution_purge_retention() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.execution_purge_retention() TO service_role;
