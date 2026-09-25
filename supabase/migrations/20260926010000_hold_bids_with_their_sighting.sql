-- Keep a lead_sighting_bids row as long as its lead_sightings row (#1167).
--
-- WHY. The two tables could not be read as a pair over a day: measured on
-- 2026-09-04, lead_sighting_bids reached back about 25 hours and lead_sightings
-- about two days, so any lead-against-bid comparison silently undercounted bids
-- in its oldest hours, and a workflow whose traffic sat only there read as
-- recording nothing. That forced the peer proof and the 6 hour window in
-- bid-recording-coverage.ts. Measured again on 2026-09-25 (read only):
-- sightings reached back to 2026-09-24 18:00 UTC, bids to 20:41, a gap of about
-- 2.5 hours, because each table was purged on its own clock (its own export
-- stamp, its own cron) and a sighting is exported up to two hours after its bids.
--
-- DECIDED by Dan on 2026-09-25: keep bid rows as long as lead rows.
--
-- THE MECHANISM. The bid purge keeps its own rule (exported more than the grace
-- ago) and adds one: its sighting is gone. Rather than aligning two clocks, the
-- bid simply follows the row it belongs to, so a sighting present in Supabase
-- always has its bids present, whatever made the sighting late (a strand
-- finalized a day later, a slow export, a sighting set aside by #427). A bid
-- whose sighting never existed is not held. The hold is bounded by the sighting
-- purge itself: measured over 2026-09-22 to 25, one sighting in 95,481 was
-- exported more than six hours after it started, so held bids are few.
--
-- Everything else in the procedure is as #541 wrote it. Replacing the whole
-- body is the only way to change one statement in a procedure; the web guard
-- purge-grace-agrees.test.ts reads the grace from whichever migration defines it
-- last, so this file carries the same default and floor.

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
        -- A bid goes only once its sighting has gone (#1167), so the two tables
        -- always cover the same stretch. Sightings are purged first in each
        -- round, so a bid normally goes in the same run as its sighting. The
        -- lookup is by id alone because the partition key of the sighting is not
        -- on the bid; lead_sightings_pkey leads with id, one probe per partition.
        DELETE FROM public.lead_sighting_bids t
        USING (SELECT b.id, b.attempted_at_utc FROM public.lead_sighting_bids b
               WHERE b.exported_at IS NOT NULL AND b.exported_at < v_cutoff
                 AND NOT EXISTS (SELECT 1 FROM public.lead_sightings s WHERE s.id = b.sighting_id)
               ORDER BY b.exported_at LIMIT v_batch) p
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
  'Deletes lead_sightings, lead_sighting_bids and achieve_evaluations rows exported to Snowflake more than 24 hours ago, in committed pages, round robin, within a time budget (#541). A bid row goes only once its sighting has (#1167). Hourly by pg_cron; recorded in job_runs as sightings-buffer-purge.';

REVOKE ALL ON PROCEDURE public.purge_exported_sightings(INTERVAL, INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated;
