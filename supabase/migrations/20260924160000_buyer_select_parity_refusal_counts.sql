-- ============================================================
-- buyer_select_parity_days.refusal_counts: the cap and budget refusals per day (#1533)
-- ============================================================
-- The Stage A exit criteria (#1414) ask for a non zero count of EACH of the four
-- cap refusals, read from this table; until now those counts were hand queries
-- over execution_steps, which the purge removes. One jsonb column keyed by the
-- refusal reason the node writes (the four caps, the rehearsal and live budget
-- deadlines, cap_check_error, breaker_unreadable, circuit_open), counted per
-- considered buyer, written by the refresh and covered by counts_hash so a
-- change clears a sign off like any other count (L641).
--
-- Expand only: one defaulted column and the upsert function taking one more key.

ALTER TABLE public.buyer_select_parity_days
  ADD COLUMN IF NOT EXISTS refusal_counts jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.buyer_select_parity_days.refusal_counts IS
  'Buyers refused before they were called, by reason, over every execution the node ran in that day (#1533): hourly_lead_cap, daily_lead_cap, hourly_spend_cap, daily_spend_cap, rehearsal_deadline, object_deadline, cap_check_error, breaker_unreadable, circuit_open. A zero is a measured zero; a row written before this column exists holds an empty object.';

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
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = (p_row->>'organization_id')::uuid) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT counts_hash, signed_off_at INTO v_prev_hash, v_signed
  FROM buyer_select_parity_days
  WHERE workflow_id = (p_row->>'workflow_id')::uuid AND et_day = (p_row->>'et_day')::date
  FOR UPDATE;

  INSERT INTO buyer_select_parity_days AS d (
    workflow_id, et_day, organization_id, sell_off_agree, sell_off_disagree, hash_match, hash_mismatch, hash_unmeasured,
    classification_agree, classification_disagree, outcome_unknown_count, state_resolved, state_unresolved,
    rehearsal_in_doubt_heals, rehearsal_expired_in_flight, decide_only_latency_p50_ms, decide_only_latency_p95_ms,
    disagreement_execution_ids, window_complete, counts_hash, executions_unpaired, unmeasured, refusal_counts, summarised_at
  ) VALUES (
    (p_row->>'workflow_id')::uuid, (p_row->>'et_day')::date, (p_row->>'organization_id')::uuid,
    (p_row->>'sell_off_agree')::integer, (p_row->>'sell_off_disagree')::integer,
    (p_row->>'hash_match')::integer, (p_row->>'hash_mismatch')::integer, (p_row->>'hash_unmeasured')::integer,
    (p_row->>'classification_agree')::integer, (p_row->>'classification_disagree')::integer, (p_row->>'outcome_unknown_count')::integer,
    (p_row->>'state_resolved')::integer, (p_row->>'state_unresolved')::integer,
    (p_row->>'rehearsal_in_doubt_heals')::integer, (p_row->>'rehearsal_expired_in_flight')::integer,
    (p_row->>'decide_only_latency_p50_ms')::integer, (p_row->>'decide_only_latency_p95_ms')::integer,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row->'disagreement_execution_ids'))::uuid[], '{}'),
    (p_row->>'window_complete')::boolean, p_row->>'counts_hash', (p_row->>'executions_unpaired')::integer,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row->'unmeasured')), '{}'),
    p_row->'refusal_counts', now()
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
  'Writes one day''s parity counts, refusal counts and their hash (#1413, #1533). Never sets the sign off columns; clears a standing sign off when the hash moves and records when. Refuses missing_key and refusal_counts_not_object (BP422) and organization_not_found (P0002).';
REVOKE ALL ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) TO service_role;
