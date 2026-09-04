-- The rate a run quoted back to the SOURCE that sent the lead, in cents.
--
-- Deliberately NOT a row in lead_sighting_bids. That table's bid_cents means
-- "what a buyer offered us for this lead" on every row it holds, and all four
-- partners in it are configured as buyers. The quote to a source is the
-- opposite direction of money, so sharing the column would make every sum and
-- average over the bids table add a cost to revenue, silently, including the
-- Snowflake view built on it.
--
-- Held on lead_sightings beside source_name, which already records who sent
-- the lead, so the pair says both the amount and who it was quoted to. That
-- generalises to any inbound relationship rather than naming one partner: the
-- engine flow and both RML bidding flows each quote a rate today.
--
-- Nullable on purpose. Null means no offer was quoted (the run was rejected,
-- or the workflow builds no offer), which is a different fact from a quote of
-- zero, and zero is recorded as zero.
--
-- Additive only, per docs/adr/0007-expand-contract-migrations.md: no default,
-- no backfill, no rename, so schema and code may deploy in either order.
-- Rows that finalized before this ships stay null, and that null is honest
-- rather than a gap to be filled: the value was never recorded for them.

alter table public.lead_sightings
  add column if not exists quoted_rate_cents integer;

comment on column public.lead_sightings.quoted_rate_cents is
  'Rate quoted to the lead''s source (see source_name), in cents. NOT a buyer bid: lead_sighting_bids.bid_cents is what a buyer offered us, this is what we quoted a source. Null = no offer quoted; zero = quoted zero.';
