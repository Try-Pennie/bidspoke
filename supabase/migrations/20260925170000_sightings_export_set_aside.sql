-- Rows Snowflake refused are set aside rather than allowed to stall the export (#427).
--
-- On 2026-06-27 a single NOT NULL mismatch failed every MERGE its batch was in,
-- and because each run selects the same unexported rows first, the export stayed
-- wedged while about 682K rows piled up. The export now halves a refused batch
-- until the refusal is pinned to one row, exports the rest, and marks that row
-- here with Snowflake's reason. The export skips a marked row, and the purge
-- never reaches it because it is never stamped exported_at.
--
-- To send a row again after fixing it, set both columns back to null.
--
-- Additive only (ADR 0007): nullable with no default, so adding them is a
-- metadata change on the partitioned parents and every partition. The lock
-- timeout makes the statement give up rather than queue behind live inserts,
-- which would block them in turn.

set lock_timeout = '5s';

alter table public.lead_sightings
  add column if not exists export_rejected_at timestamptz,
  add column if not exists export_rejected_reason text;

alter table public.lead_sighting_bids
  add column if not exists export_rejected_at timestamptz,
  add column if not exists export_rejected_reason text;

comment on column public.lead_sightings.export_rejected_at is
  'When Snowflake refused this row and the export set it aside (#427). Null means not set aside. Clear with export_rejected_reason to send it again.';
comment on column public.lead_sightings.export_rejected_reason is
  'Snowflake''s own reason for refusing the row, as the export received it (#427).';
comment on column public.lead_sighting_bids.export_rejected_at is
  'When Snowflake refused this row and the export set it aside (#427). Null means not set aside. Clear with export_rejected_reason to send it again.';
comment on column public.lead_sighting_bids.export_rejected_reason is
  'Snowflake''s own reason for refusing the row, as the export received it (#427).';
