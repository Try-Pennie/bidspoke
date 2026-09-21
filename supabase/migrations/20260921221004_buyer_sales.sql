-- buyer_sales: the durable record of every reservation and outcome the
-- buyer_select node makes (#1409). The per buyer ledger Durable Object stays the
-- live authority for caps, so selling survives a Supabase outage; this table is
-- the copy the partner page, the reconciliation checks and Snowflake read, and it
-- is what an unresolved sale is settled against.
--
-- Not partitioned, because the unique keys must span all time. One row per
-- (partner, lead, population, kind), upserted through record_buyer_sale with a
-- status rank guard so a late `reserved` can never overwrite `accepted`. The
-- partial unique index refuses a second accepted live sale of one lead in the
-- database itself, independent of the object that should have refused it first
-- (L58). Rehearsal rows are a separate kind and never collide with live ones.
--
-- Access (L18): Worker only, same as the profile tables.
--
-- Expand only: a new table nothing writes yet.

CREATE TABLE public.buyer_sales (
  id                     uuid PRIMARY KEY,
  partner_id             uuid NOT NULL REFERENCES public.partner_configs(id) ON DELETE RESTRICT,
  organization_id        uuid NOT NULL REFERENCES public.organizations(id),
  lead_key               text NOT NULL,
  population             text NOT NULL,
  kind                   text NOT NULL,
  status                 text NOT NULL,
  payout_cents           bigint NOT NULL,
  debt                   numeric,
  multiplier             numeric(8,6),
  et_day                 date NOT NULL,
  hour_bucket            timestamptz NOT NULL,
  workflow_id            uuid,
  execution_id           uuid,
  trace_id               text,
  http_status            integer,
  result_code            text,
  buyer_reference        text,
  live_percent_in_force  integer,
  caps_in_force          jsonb,
  resolution_source      text,
  resolved_by            uuid REFERENCES public.users(id),
  reserved_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_sales_kind_check CHECK (kind IN ('live', 'rehearsal')),
  CONSTRAINT buyer_sales_status_check CHECK (status IN ('reserved', 'accepted', 'declined', 'released', 'unresolved')),
  CONSTRAINT buyer_sales_payout_not_negative CHECK (payout_cents >= 0),
  CONSTRAINT buyer_sales_partner_lead_population_kind_key UNIQUE (partner_id, lead_key, population, kind)
);

COMMENT ON TABLE public.buyer_sales IS
  'Every reservation and outcome buyer_select records, one row per partner, lead, population and kind, written through record_buyer_sale (#1409). The ledger Durable Object is the live authority; this is the durable copy everything else reads.';
COMMENT ON COLUMN public.buyer_sales.kind IS 'live sold a lead; rehearsal reserved and committed without a buyer call, during Stage A of the cutover.';
COMMENT ON COLUMN public.buyer_sales.status IS 'reserved, then accepted, declined, released, or unresolved (an outcome nobody could classify, held until a person settles it).';
COMMENT ON COLUMN public.buyer_sales.live_percent_in_force IS 'The live share in force for this execution, so the daily report reads the value that applied and not the value now (L529).';

CREATE UNIQUE INDEX buyer_sales_one_accepted_live_per_lead
  ON public.buyer_sales (lead_key, population) WHERE status = 'accepted' AND kind = 'live';
CREATE INDEX buyer_sales_partner_day_idx ON public.buyer_sales (partner_id, et_day);
CREATE INDEX buyer_sales_unresolved_idx ON public.buyer_sales (status) WHERE status = 'unresolved';
CREATE INDEX buyer_sales_org_idx ON public.buyer_sales (organization_id);

CREATE TRIGGER buyer_sales_updated_at BEFORE UPDATE ON public.buyer_sales
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.buyer_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_sales FROM PUBLIC, anon, authenticated;
