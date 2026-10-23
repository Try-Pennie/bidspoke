-- Drop save_buyer_profile (#2187, the contract step after #2133, part of #2114).
--
-- The expand half is live: since #2133 the partners page saves the profile
-- through save_partner_page, and PR #2735 (deployed 2026-10-23) retired the old
-- PUT /api/partners/:id/buyer-profile route, its only caller in code, after it
-- went seven UTC days without a call (its KV counter, 2026-10-15 to 2026-10-22),
-- per docs/adr/0007-expand-contract-migrations.md. Dan approved the drop.
--
-- Dependencies measured on production (read only, 2026-10-23): no function
-- calls it. buyer_profile_tables_direct_sql_audit, buyer_profile_tables_page_notice
-- and save_partner_page name it only in comments or as an audit_handled value
-- in an IN list, which simply stops matching once nothing sets it.
--
-- What is lost: a way to write a profile without comparing the partner's
-- version. The one recorded use outside the route (2026-10-16, Liberty1's
-- collections cap, set by hand before the page had the field) is a save the
-- page makes now.

DROP FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text);

COMMENT ON FUNCTION public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb) IS
  'The body of a buyer profile save (#2133): the kind, delivery, display time zone (#2143) and collections cap (#2111) rules, the rows, tier contiguity, the version bump and one audit row of changed paths plus p_audit_extra. Internal: its caller holds the partner and profile row locks, in that order, and has compared the version. Called by save_partner_page only, since save_buyer_profile was dropped (#2187).';
