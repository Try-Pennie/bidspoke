-- ============================================================
-- buyer_select_parity_days.stage_b: the Stage B daily report (#1809)
-- ============================================================
-- Each live percent step of the Engine cutover (#1414) is judged on the same
-- criteria: attempts, the canary accept rate against the legacy arm, the added
-- latency against the ceiling, and one Tripoint bid row per execution. The
-- 1 percent review on 2026-10-06 took a few dozen hand queries over tables
-- purged within a week, with most of the period's bid rows already gone. The
-- hourly parity refresh now writes those figures beside each day's counts, so
-- they outlive the purge.
--
-- One jsonb column rather than a column per figure, because the report is read
-- whole per day and its shape is the Worker's (buyer-select-stage-b.ts), as
-- refusal_counts is. It is NOT part of counts_hash: a sign off approves the
-- Stage A counts, and a Stage B figure moving must not clear it.
--
-- Expand only, and safe in either deploy order. The column is nullable with no
-- default: NULL means the row was written by code that did not compute it,
-- never an empty report (L90). The function writes the key when present and
-- NULL when absent, so it neither refuses an older Worker's row nor invents a
-- report for it; and an older function ignores the key, so a newer Worker
-- writing before this is applied loses only the report, never the row.
--
-- One rule beyond writing what it is given: a bid check the Worker could not
-- measure (the day's bid rows have drained) does not replace one it measured
-- earlier, because the hourly refresh re-reads yesterday all day and would
-- otherwise erase the day's only real answer.

ALTER TABLE public.buyer_select_parity_days
  ADD COLUMN IF NOT EXISTS stage_b jsonb;

COMMENT ON COLUMN public.buyer_select_parity_days.stage_b IS
  'The Stage B report for the day (#1809): canary and legacy attempts, accepts and answer codes, latency percentiles with the buyer call split out, the added time against the legacy step, and the one bid row per execution check (or why it was unmeasured). Shape in apps/worker/src/lib/buyer-select-stage-b.ts. Outside counts_hash. NULL on a row written before the refresh computed it.';

CREATE OR REPLACE FUNCTION public.upsert_buyer_select_parity_day(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_required text[] := ARRAY[
    'workflow_id', 'et_day', 'organization_id', 'sell_off_agree', 'sell_off_disagree', 'hash_match', 'hash_mismatch', 'hash_unmeasured',
    'classification_agree', 'classification_disagree', 'outcome_unknown_count', 'state_resolved', 'state_unresolved',
    'rehearsal_in_doubt_heals', 'rehearsal_expired_in_flight', 'decide_only_latency_p50_ms', 'decide_only_latency_p95_ms',
    'disagreement_execution_ids', 'window_complete', 'counts_hash', 'executions_unpaired', 'unmeasured', 'refusal_counts'
  ];
  k text;
  v_prev_hash text;
  v_signed timestamptz;
  v_out jsonb;
BEGIN
  FOREACH k IN ARRAY v_required LOOP
    IF NOT (p_row ? k) THEN
      RAISE EXCEPTION 'missing_key' USING ERRCODE = 'BP422', DETAIL = k;
    END IF;
  END LOOP;
  IF jsonb_typeof(p_row->'refusal_counts') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'refusal_counts_not_object' USING ERRCODE = 'BP422', DETAIL = COALESCE(jsonb_typeof(p_row->'refusal_counts'), 'null');
  END IF;
  -- Optional: an older Worker sends none, and a row read back and re-sent carries a JSON null;
  -- both are written NULL (unmeasured), never refused. Anything else but an object is refused.
  IF p_row ? 'stage_b' AND jsonb_typeof(p_row->'stage_b') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'stage_b_not_object' USING ERRCODE = 'BP422', DETAIL = COALESCE(jsonb_typeof(p_row->'stage_b'), 'null');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = (p_row->>'organization_id')::uuid) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT counts_hash, signed_off_at INTO v_prev_hash, v_signed
  FROM buyer_select_parity_days
  WHERE workflow_id = (p_row->>'workflow_id')::uuid AND et_day = (p_row->>'et_day')::date
  FOR UPDATE;

  INSERT INTO buyer_select_parity_days AS d (
    workflow_id, et_day, organization_id, sell_off_agree, sell_off_disagree, hash_match, hash_mismatch, hash_unmeasured,
    classification_agree, classification_disagree, outcome_unknown_count, incumbent_unknown_count, state_resolved, state_unresolved,
    rehearsal_in_doubt_heals, rehearsal_expired_in_flight, decide_only_latency_p50_ms, decide_only_latency_p95_ms,
    disagreement_execution_ids, window_complete, counts_hash, executions_unpaired, unmeasured, refusal_counts, stage_b, summarised_at
  ) VALUES (
    (p_row->>'workflow_id')::uuid, (p_row->>'et_day')::date, (p_row->>'organization_id')::uuid,
    (p_row->>'sell_off_agree')::integer, (p_row->>'sell_off_disagree')::integer,
    (p_row->>'hash_match')::integer, (p_row->>'hash_mismatch')::integer, (p_row->>'hash_unmeasured')::integer,
    (p_row->>'classification_agree')::integer, (p_row->>'classification_disagree')::integer, (p_row->>'outcome_unknown_count')::integer,
    (p_row->>'incumbent_unknown_count')::integer,
    (p_row->>'state_resolved')::integer, (p_row->>'state_unresolved')::integer,
    (p_row->>'rehearsal_in_doubt_heals')::integer, (p_row->>'rehearsal_expired_in_flight')::integer,
    (p_row->>'decide_only_latency_p50_ms')::integer, (p_row->>'decide_only_latency_p95_ms')::integer,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row->'disagreement_execution_ids'))::uuid[], '{}'),
    (p_row->>'window_complete')::boolean, p_row->>'counts_hash', (p_row->>'executions_unpaired')::integer,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row->'unmeasured')), '{}'),
    p_row->'refusal_counts', CASE WHEN jsonb_typeof(p_row->'stage_b') = 'object' THEN p_row->'stage_b' END, now()
  )
  ON CONFLICT (workflow_id, et_day) DO UPDATE SET
    sell_off_agree = EXCLUDED.sell_off_agree,
    sell_off_disagree = EXCLUDED.sell_off_disagree,
    hash_match = EXCLUDED.hash_match,
    hash_mismatch = EXCLUDED.hash_mismatch,
    hash_unmeasured = EXCLUDED.hash_unmeasured,
    classification_agree = EXCLUDED.classification_agree,
    classification_disagree = EXCLUDED.classification_disagree,
    outcome_unknown_count = EXCLUDED.outcome_unknown_count,
    incumbent_unknown_count = EXCLUDED.incumbent_unknown_count,
    state_resolved = EXCLUDED.state_resolved,
    state_unresolved = EXCLUDED.state_unresolved,
    rehearsal_in_doubt_heals = EXCLUDED.rehearsal_in_doubt_heals,
    rehearsal_expired_in_flight = EXCLUDED.rehearsal_expired_in_flight,
    decide_only_latency_p50_ms = EXCLUDED.decide_only_latency_p50_ms,
    decide_only_latency_p95_ms = EXCLUDED.decide_only_latency_p95_ms,
    disagreement_execution_ids = EXCLUDED.disagreement_execution_ids,
    window_complete = EXCLUDED.window_complete,
    counts_hash = EXCLUDED.counts_hash,
    executions_unpaired = EXCLUDED.executions_unpaired,
    unmeasured = EXCLUDED.unmeasured,
    refusal_counts = EXCLUDED.refusal_counts,
    -- A measured bid check is kept when a later run could not measure it: the
    -- refresh re-reads yesterday every hour, and once that day's bid rows have
    -- drained (about 05:00 ET) each run would otherwise erase the only real
    -- answer the day had (L5). The rest of the newer report is still written.
    stage_b = CASE
      WHEN EXCLUDED.stage_b IS NOT NULL
        AND (EXCLUDED.stage_b->'bid_rows') ? 'unmeasured'
        AND jsonb_typeof(d.stage_b->'bid_rows') = 'object'
        AND NOT ((d.stage_b->'bid_rows') ? 'unmeasured')
      THEN jsonb_set(EXCLUDED.stage_b, '{bid_rows}', d.stage_b->'bid_rows')
      ELSE EXCLUDED.stage_b
    END,
    summarised_at = now(),
    -- A sign off stands only while the numbers it approved stand (L641). The
    -- sign off columns are otherwise untouched by this function.
    signed_off_at = CASE WHEN d.signed_off_at IS NOT NULL AND d.counts_hash IS DISTINCT FROM EXCLUDED.counts_hash THEN NULL ELSE d.signed_off_at END,
    sign_off_cleared_at = CASE WHEN d.signed_off_at IS NOT NULL AND d.counts_hash IS DISTINCT FROM EXCLUDED.counts_hash THEN now() ELSE d.sign_off_cleared_at END;

  SELECT to_jsonb(d) INTO v_out FROM buyer_select_parity_days d
  WHERE d.workflow_id = (p_row->>'workflow_id')::uuid AND d.et_day = (p_row->>'et_day')::date;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) IS
  'Writes one day''s parity counts, refusal counts, the incumbent unknown count and their hash (#1413, #1533, #1540), and the Stage B report outside the hash (#1809). Never sets the sign off columns; clears a standing sign off when the hash moves and records when. Refuses missing_key, refusal_counts_not_object and stage_b_not_object (BP422) and organization_not_found (P0002). incumbent_unknown_count and stage_b are written NULL when absent, meaning unmeasured.';
REVOKE ALL ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) TO service_role;
