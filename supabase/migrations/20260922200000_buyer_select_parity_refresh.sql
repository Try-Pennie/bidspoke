-- buyer_select_parity_days: the refresh and the sign off as two functions that
-- never touch each other's columns (#1413, Phase 6, L206, L641, L705).
--
-- The plan first had a GET route both read and upsert this table. A GET that
-- writes is the inspection named tool that modifies data (L206), and a full row
-- upsert either nulled a sign off or left one standing over counts nobody saw
-- (L641). So:
--   upsert_buyer_select_parity_day writes the count columns and a hash of them,
--     never the sign off columns; when the hash of a signed off day changes it
--     clears signed_off_at and records when, so a signed off row always vouches
--     for the numbers it carries.
--   sign_off_buyer_select_parity_day records the hash the person approved, and
--     refuses when the hash they saw is not the hash the row holds now.
--
-- Expand only: four nullable or defaulted columns and two new functions.

ALTER TABLE public.buyer_select_parity_days
  ADD COLUMN IF NOT EXISTS counts_hash text,
  ADD COLUMN IF NOT EXISTS sign_off_counts_hash text,
  ADD COLUMN IF NOT EXISTS sign_off_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS executions_unpaired integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unmeasured text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.buyer_select_parity_days.counts_hash IS
  'SHA-256 over the count columns as the refresh computed them, so a sign off can name the numbers it approved (L641).';
COMMENT ON COLUMN public.buyer_select_parity_days.sign_off_counts_hash IS
  'The counts_hash at the moment of sign off. Differs from counts_hash only if a refresh changed the numbers afterwards, in which case signed_off_at is cleared.';
COMMENT ON COLUMN public.buyer_select_parity_days.sign_off_cleared_at IS
  'When a refresh cleared a standing sign off because the counts moved. Null when no sign off was ever cleared.';
COMMENT ON COLUMN public.buyer_select_parity_days.executions_unpaired IS
  'Executions with only one of the two rows (node or incumbent), compared on nothing.';
COMMENT ON COLUMN public.buyer_select_parity_days.unmeasured IS
  'What the summary could not measure, by name; a zero in a count listed here is not a measurement (L90).';

-- ── upsert_buyer_select_parity_day ───────────────────────────────────────────
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
    'disagreement_execution_ids', 'window_complete', 'counts_hash', 'executions_unpaired', 'unmeasured'
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
    disagreement_execution_ids, window_complete, counts_hash, executions_unpaired, unmeasured, summarised_at
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
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_row->'unmeasured')), '{}'), now()
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
  'Writes one day''s parity counts and their hash (#1413). Never sets the sign off columns; clears a standing sign off when the hash moves and records when. Refuses missing_key (BP422) and organization_not_found (P0002).';
REVOKE ALL ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_buyer_select_parity_day(jsonb) TO service_role;

-- ── sign_off_buyer_select_parity_day ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sign_off_buyer_select_parity_day(
  p_workflow uuid,
  p_day date,
  p_org uuid,
  p_actor uuid,
  p_counts_hash text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_hash text;
  v_out jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = 'BP422';
  END IF;
  SELECT counts_hash INTO v_hash FROM buyer_select_parity_days
  WHERE workflow_id = p_workflow AND et_day = p_day AND organization_id = p_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parity_day_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- The person signs off the numbers they saw. A refresh between the read and
  -- the sign off is a refusal, never a sign off over numbers nobody saw (L641).
  IF v_hash IS DISTINCT FROM p_counts_hash THEN
    RAISE EXCEPTION 'counts_changed' USING ERRCODE = 'BP409', DETAIL = COALESCE(v_hash, 'null');
  END IF;
  UPDATE buyer_select_parity_days
  SET signed_off_by = p_actor, signed_off_at = now(), sign_off_note = p_note, sign_off_counts_hash = p_counts_hash
  WHERE workflow_id = p_workflow AND et_day = p_day;
  SELECT to_jsonb(d) INTO v_out FROM buyer_select_parity_days d WHERE d.workflow_id = p_workflow AND d.et_day = p_day;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.sign_off_buyer_select_parity_day(uuid, date, uuid, uuid, text, text) IS
  'Records a person''s sign off of one parity day against the counts hash they saw (#1413). Refuses actor_required (BP422), parity_day_not_found (P0002) and counts_changed (BP409, detail carries the current hash).';
REVOKE ALL ON FUNCTION public.sign_off_buyer_select_parity_day(uuid, date, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_off_buyer_select_parity_day(uuid, date, uuid, uuid, text, text) TO service_role;
