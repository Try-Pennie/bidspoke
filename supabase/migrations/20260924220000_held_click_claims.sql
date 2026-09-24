-- held_click_claims: the clicks a person has to release (#1552).
--
-- buyer_click_send (#1542) keeps a click claim held when it cannot know whether
-- the buyer created the record (no readable answer, a sold mark or a free that
-- failed), and finds one held when an earlier send never recorded its outcome.
-- The claim lives in a LeadSaleObject, which cannot be listed, and the step rows
-- that name it are purged after 7 days while the claim is held for good. So the
-- node writes one row here per held claim, and the partner page lists them from
-- it. The claim object stays the authority: the page reads each claim's live
-- state and generation from the object, and a release is a compare and set on
-- the object first; this row is only how the page knows which objects to ask.
--
-- One row per buyer and prospect, because that is one claim. A release deletes
-- the row, and the audit log keeps the old and new state of the claim.
--
-- record_held_click writes it. A second sighting of a claim already held (the
-- claim_in_doubt reason: a later click found it) moves only last_execution_id
-- and last_seen_at, so the row keeps when and why the claim was first held. Any
-- other reason happens straight after a fresh claim, which means the claim had
-- been free, so a row still there is left over from an earlier hold and is
-- replaced whole. The release deletes the row only when last_execution_id is
-- still the one the page read, so a hold recorded while the person acted is not
-- deleted with the old one.
--
-- Access (L18): Worker only, same as the other buyer tables. RLS on, no policy,
-- every grant revoked from anon and authenticated.
--
-- Expand only: a new table and a new function; nothing existing changes. The
-- node tolerates the function being absent, so the code can deploy first.

CREATE TABLE public.held_click_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id),
  partner_id         uuid NOT NULL REFERENCES public.partner_configs(id) ON DELETE RESTRICT,
  prospect_id        text NOT NULL,
  reason             text NOT NULL,
  detail             text NOT NULL,
  partner_lead_id    text,
  workflow_id        uuid,
  execution_id       text NOT NULL,
  trace_id           text,
  held_at            timestamptz NOT NULL DEFAULT now(),
  last_execution_id  text NOT NULL,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_click_claims_reason_check CHECK (reason IN ('outcome_unknown', 'claim_in_doubt', 'sold_mark_failed', 'free_failed')),
  CONSTRAINT held_click_claims_prospect_length CHECK (length(prospect_id) BETWEEN 1 AND 200),
  CONSTRAINT held_click_claims_partner_prospect_key UNIQUE (partner_id, prospect_id)
);

COMMENT ON TABLE public.held_click_claims IS
  'One row per click claim buyer_click_send left held, so a person can find and release it from the partner page (#1552). The LeadSaleObject is the authority; a release deletes the row.';
COMMENT ON COLUMN public.held_click_claims.reason IS
  'Why the claim was first held: outcome_unknown (no readable answer), sold_mark_failed (the buyer created it, the claim could not be marked sold), free_failed (the buyer refused it, the claim could not be freed), claim_in_doubt (a later click found it held and no earlier row existed).';
COMMENT ON COLUMN public.held_click_claims.partner_lead_id IS
  'The buyer''s lead id when the buyer confirmed the record (sold_mark_failed); null when it is not known.';
COMMENT ON COLUMN public.held_click_claims.last_execution_id IS
  'The latest execution that recorded this claim held. A release deletes the row only while this is the value the page read.';

CREATE INDEX held_click_claims_org_partner_idx ON public.held_click_claims (organization_id, partner_id, held_at);

ALTER TABLE public.held_click_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.held_click_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.held_click_claims TO service_role;

-- ── record_held_click ────────────────────────────────────────────────────────
-- Upserts the row for one held claim and returns the stored row, so the caller
-- confirms what landed rather than what it sent (L581). Refuses a partner the
-- organization does not hold (BP404), because the row carries both and the
-- page trusts the pair.
CREATE OR REPLACE FUNCTION public.record_held_click(
  p_org uuid,
  p_partner uuid,
  p_prospect text,
  p_reason text,
  p_detail text,
  p_partner_lead_id text,
  p_workflow uuid,
  p_execution text,
  p_trace text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partner_configs WHERE id = p_partner AND organization_id = p_org) THEN
    RAISE EXCEPTION 'partner_not_in_org' USING ERRCODE = 'BP404', DETAIL = format('partner %s in organization %s', p_partner, p_org);
  END IF;

  INSERT INTO held_click_claims AS h (
    organization_id, partner_id, prospect_id, reason, detail, partner_lead_id, workflow_id, execution_id, trace_id, last_execution_id
  ) VALUES (
    p_org, p_partner, p_prospect, p_reason, p_detail, p_partner_lead_id, p_workflow, p_execution, p_trace, p_execution
  )
  ON CONFLICT (partner_id, prospect_id) DO UPDATE SET
    last_execution_id = EXCLUDED.last_execution_id,
    last_seen_at = now(),
    reason = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.reason ELSE EXCLUDED.reason END,
    detail = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.detail ELSE EXCLUDED.detail END,
    partner_lead_id = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.partner_lead_id ELSE EXCLUDED.partner_lead_id END,
    workflow_id = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.workflow_id ELSE EXCLUDED.workflow_id END,
    execution_id = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.execution_id ELSE EXCLUDED.execution_id END,
    trace_id = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.trace_id ELSE EXCLUDED.trace_id END,
    held_at = CASE WHEN EXCLUDED.reason = 'claim_in_doubt' THEN h.held_at ELSE now() END;

  SELECT to_jsonb(h) INTO v_out FROM held_click_claims h WHERE h.partner_id = p_partner AND h.prospect_id = p_prospect;
  RETURN v_out;
END
$$;
COMMENT ON FUNCTION public.record_held_click(uuid, uuid, text, text, text, text, uuid, text, text) IS
  'Record one held click claim for the partner page (#1552). A claim_in_doubt sighting keeps the first hold and moves last_execution_id; any other reason replaces a left over row. Refuses partner_not_in_org (BP404). Returns the stored row.';
REVOKE ALL ON FUNCTION public.record_held_click(uuid, uuid, text, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_held_click(uuid, uuid, text, text, text, text, uuid, text, text) TO service_role;
