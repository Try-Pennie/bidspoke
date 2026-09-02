-- Revoking from PUBLIC does not remove a grant made DIRECTLY to a role, and
-- Supabase's default privileges grant EXECUTE on a new public function to anon
-- and authenticated. So `field_presence_window` (#1101) shipped executable by
-- anon despite carrying its own `REVOKE ALL ... FROM PUBLIC`. Measured against
-- production on 2026-09-02, minutes after it was created:
--
--   service_role   true
--   anon           true    <- wrong
--   authenticated  true    <- wrong
--
-- This is the same trap as #762 (LESSONS L124): the only evidence of a missing
-- revoke is an absence, so it has to be asserted against the live database
-- rather than inferred from the migration that intended it. The pattern that
-- issue established revokes from all three explicitly, and this follows it.
--
-- It matters because the function enumerates every watched field path on every
-- workflow together with its run counts, which is internal structure and
-- volume, and the anon key ships in the client bundle.
--
-- Written as a follow-up rather than an edit to 20260902154023, so no already
-- applied migration changes under anyone who ran it. Idempotent, and a no-op
-- against production, where the same revokes were applied by hand as soon as
-- the wrong grant was measured.
--
-- The deploy's `Assert required objects and grants` step is what would have
-- caught this on its own: `supabase/required-live-objects.json` already declares
-- this function as `"anon": "denied"`, and that probe runs against the live
-- database with the public anon key.

REVOKE ALL ON ROUTINE field_presence_window(UUID[], TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE field_presence_window(UUID[], TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE field_presence_window(UUID[], TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION field_presence_window(UUID[], TIMESTAMPTZ) TO service_role;
