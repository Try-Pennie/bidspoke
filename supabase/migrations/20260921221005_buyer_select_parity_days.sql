-- buyer_select_parity_days: the per Eastern day record of Stage A, the week the
-- buyer_select node runs decide only beside the live tripoint_ping step and its
-- decisions are compared with what the incumbent did (#1409, plan Phase 6 and 7).
--
-- execution_steps, where the comparison is computed from, is purged after 7 days,
-- so the Stage A exit criteria cannot be read from it (L202). This table outlives
-- the purge: the parity route upserts one row per workflow and day with every
-- count, the execution ids of each disagreement, and whether the day's window was
-- still complete when it was summarised. Dan's sign off on a disagreement is a
-- stamp on the row.
--
-- Access (L18): Worker only.
--
-- Expand only: a new table nothing writes yet.

CREATE TABLE public.buyer_select_parity_days (
  workflow_id                    uuid NOT NULL,
  et_day                         date NOT NULL,
  organization_id                uuid NOT NULL REFERENCES public.organizations(id),
  sell_off_agree                 integer NOT NULL DEFAULT 0,
  sell_off_disagree              integer NOT NULL DEFAULT 0,
  hash_match                     integer NOT NULL DEFAULT 0,
  hash_mismatch                  integer NOT NULL DEFAULT 0,
  hash_unmeasured                integer NOT NULL DEFAULT 0,
  classification_agree           integer NOT NULL DEFAULT 0,
  classification_disagree        integer NOT NULL DEFAULT 0,
  outcome_unknown_count          integer NOT NULL DEFAULT 0,
  state_resolved                 integer NOT NULL DEFAULT 0,
  state_unresolved               integer NOT NULL DEFAULT 0,
  rehearsal_in_doubt_heals       integer NOT NULL DEFAULT 0,
  rehearsal_expired_in_flight    integer NOT NULL DEFAULT 0,
  decide_only_latency_p50_ms     integer,
  decide_only_latency_p95_ms     integer,
  disagreement_execution_ids     uuid[] NOT NULL DEFAULT '{}',
  window_complete                boolean NOT NULL DEFAULT false,
  signed_off_by                  uuid REFERENCES public.users(id),
  signed_off_at                  timestamptz,
  sign_off_note                  text,
  summarised_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_select_parity_days_pkey PRIMARY KEY (workflow_id, et_day)
);

COMMENT ON TABLE public.buyer_select_parity_days IS
  'Per Eastern day comparison of buyer_select decide only decisions against the incumbent seller during Stage A (#1409). Outlives the execution_steps purge; the Stage A exit criteria are read from here.';
COMMENT ON COLUMN public.buyer_select_parity_days.window_complete IS
  'True only when the whole Eastern day was inside the retention window when summarised. A day summarised while still being written, or after part of it was purged, is false and is never read as measured (L696, L202).';
COMMENT ON COLUMN public.buyer_select_parity_days.decide_only_latency_p95_ms IS
  'Added latency of the node in decide only mode. Excludes the buyer call, so it is not the live path figure (L102).';

ALTER TABLE public.buyer_select_parity_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_select_parity_days FROM PUBLIC, anon, authenticated;
