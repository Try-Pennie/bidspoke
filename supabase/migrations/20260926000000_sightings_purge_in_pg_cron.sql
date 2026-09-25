-- The sightings buffer purge moves from the Worker into the database (#541).
--
-- WHY. The purge deletes rows already exported to Snowflake more than a day ago
-- from lead_sightings, lead_sighting_bids and achieve_evaluations. It is pure
-- database work, but it ran through the Worker's PostgREST path: 200 ids per
-- request, each a subrequest against a per-invocation ceiling, each statement
-- under service_role's 30s timeout, two crons (one per table, because one table's
-- backlog once starved the other of subrequests), and a zero-row detector to
-- catch the budget running out before anything was deleted (#613). That path is
-- where the 57014 saga lived, while a pg_cron drain deleted 55K rows in eleven
-- minutes without incident.
--
-- WHAT RUNS NOW. `purge_exported_sightings`, hourly at :13 (clear of the :00 and
-- :30 strand drain, the :23 archive and the :37 export). It deletes pages of up
-- to 5,000 rows, round robin across the three tables so no table's backlog can
-- starve the others, each page chosen through the purge index in exported_at
-- order and deleted by its full primary key (id plus partition key, so each row
-- prunes to its own partition), COMMITting after every page. It stops at its
-- own budget (60s by default, well under the 2 minute statement timeout pg_cron
-- runs under), and the next hour carries on.
--
-- THE PREDICATE is unchanged from the Worker's (purgeOldExported): exported_at
-- IS NOT NULL AND exported_at older than the grace. So a row not yet exported,
-- or set aside because Snowflake refused it (#427, exported_at stays NULL), or
-- an Achieve sandbox row (never exported) is never touched. Sandbox rows keep
-- their own seven day retention in the Worker (purgeSandboxEvaluations), which
-- is keyed on is_sandbox and not on the export at all.
--
-- THE GRACE is 24 hours and cannot be shortened by a caller: the argument is a
-- floor. PURGE_GRACE_HOURS in sightings-export.ts is the same figure and a test
-- there reads this file to keep the two equal.
--
-- THE RECORD. Each run writes a job_runs row (job 'sightings-buffer-purge'),
-- committed before any delete, and closes it with per-table counts and whether
-- it drained ('ok') or stopped at its budget with work left ('budget'). A run
-- that dies leaves the row open, which is the evidence (#960). pg_cron records
-- the failure in cron.job_run_details, and pg-cron-watch pages on a failed run
-- and on the job no longer running. The daily buffer watchdog (#463) pages when
-- rows past the purge window pile up whatever the cause.
--
-- DEPLOY ORDER (ADR 0007). Applying this starts the hourly job while the Worker
-- purge is still deployed. Both delete the same rows by the same predicate, so
-- running both is harmless: a row one has deleted is simply not there for the
-- other. The Worker purge goes with the deploy of the PR that ships this.

CREATE OR REPLACE PROCEDURE public.purge_exported_sightings(
  p_budget INTERVAL DEFAULT interval '60 seconds',
  p_batch  INTEGER  DEFAULT 5000,
  p_grace  INTERVAL DEFAULT interval '24 hours'
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_run     UUID;
  v_started TIMESTAMPTZ := clock_timestamp();
  v_cutoff  TIMESTAMPTZ := now() - greatest(p_grace, interval '24 hours');
  v_batch   INTEGER := greatest(p_batch, 1);
  v_done    BOOLEAN[] := ARRAY[false, false, false];
  v_counts  BIGINT[]  := ARRAY[0, 0, 0];
  v_n       BIGINT;
  v_i       INTEGER;
  v_stopped BOOLEAN := false;
BEGIN
  -- A procedure that COMMITs cannot carry a SET clause, so these are set here.
  -- The search path is pinned for the same reason a SET clause would pin it.
  PERFORM set_config('search_path', 'pg_catalog, public', false);
  PERFORM set_config('lock_timeout', '5s', false);

  INSERT INTO public.job_runs (job, started_at) VALUES ('sightings-buffer-purge', now()) RETURNING id INTO v_run;
  COMMIT;

  <<rounds>>
  LOOP
    EXIT rounds WHEN v_done[1] AND v_done[2] AND v_done[3];
    FOR v_i IN 1..3 LOOP
      CONTINUE WHEN v_done[v_i];
      IF clock_timestamp() - v_started >= p_budget THEN
        v_stopped := true;
        EXIT rounds;
      END IF;

      -- One static statement per table rather than dynamic SQL: the three
      -- partition keys differ, and no name ever comes from outside.
      IF v_i = 1 THEN
        DELETE FROM public.lead_sightings t
        USING (SELECT id, execution_started_at_utc FROM public.lead_sightings
               WHERE exported_at IS NOT NULL AND exported_at < v_cutoff
               ORDER BY exported_at LIMIT v_batch) p
        WHERE t.id = p.id AND t.execution_started_at_utc = p.execution_started_at_utc;
      ELSIF v_i = 2 THEN
        DELETE FROM public.lead_sighting_bids t
        USING (SELECT id, attempted_at_utc FROM public.lead_sighting_bids
               WHERE exported_at IS NOT NULL AND exported_at < v_cutoff
               ORDER BY exported_at LIMIT v_batch) p
        WHERE t.id = p.id AND t.attempted_at_utc = p.attempted_at_utc;
      ELSE
        DELETE FROM public.achieve_evaluations t
        USING (SELECT id, requested_at_utc FROM public.achieve_evaluations
               WHERE exported_at IS NOT NULL AND exported_at < v_cutoff
               ORDER BY exported_at LIMIT v_batch) p
        WHERE t.id = p.id AND t.requested_at_utc = p.requested_at_utc;
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_counts[v_i] := v_counts[v_i] + v_n;
      IF v_n < v_batch THEN v_done[v_i] := true; END IF;
      COMMIT;
    END LOOP;
  END LOOP;

  UPDATE public.job_runs
  SET finished_at = now(),
      outcome = CASE WHEN v_stopped THEN 'budget' ELSE 'ok' END,
      detail = CASE WHEN v_stopped THEN 'stopped at its budget with rows still to purge; the next run carries on' END,
      summary = jsonb_build_object(
        'lead_sightings', v_counts[1],
        'lead_sighting_bids', v_counts[2],
        'achieve_evaluations', v_counts[3],
        'cutoff', v_cutoff,
        'batch', v_batch,
        'budget_seconds', extract(epoch FROM p_budget)
      )
  WHERE id = v_run;
  COMMIT;
END;
$$;

COMMENT ON PROCEDURE public.purge_exported_sightings(INTERVAL, INTEGER, INTERVAL) IS
  'Deletes lead_sightings, lead_sighting_bids and achieve_evaluations rows exported to Snowflake more than 24 hours ago, in committed pages, round robin, within a time budget (#541). Hourly by pg_cron; recorded in job_runs as sightings-buffer-purge.';

-- Only the database's own scheduler runs it. It is not an RPC.
REVOKE ALL ON PROCEDURE public.purge_exported_sightings(INTERVAL, INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated;

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-exported-sightings'; END $$;
SELECT cron.schedule(
  'purge-exported-sightings',
  '13 * * * *',
  'CALL public.purge_exported_sightings()'
);
