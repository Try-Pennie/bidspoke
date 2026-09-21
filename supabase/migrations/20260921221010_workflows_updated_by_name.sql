-- workflows.updated_by_name exists in production and in the committed
-- database.ts, but no migration ever created it (#1409, L31).
--
-- Found on 2026-09-21 by regenerating the types from a database built by
-- replaying every migration from empty: the column was absent there and present
-- in production, so it was added to production by hand at some point. The other
-- two tables that carry the column (partner_configs, partner_bid_configs) got it
-- through migrations 20260409000001 and 20260429000002.
--
-- Expand only, and a no-op on production because of IF NOT EXISTS: it brings
-- the migration set into line with the database it describes, so a replay from
-- empty produces the schema production has.
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS updated_by_name text;

COMMENT ON COLUMN public.workflows.updated_by_name IS
  'Display name of the last editor, recorded beside updated_by and updated_by_email. Added to the migration set on 2026-09-21 after being found only in production (#1409).';
