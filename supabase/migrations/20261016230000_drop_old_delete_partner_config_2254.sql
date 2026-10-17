-- Drop the four argument delete_partner_config (#2254, part of #2114), the
-- contract step after PR9 (#2140, #2241) per docs/adr/0007-expand-contract-migrations.md.
--
-- 20261016182000_partner_delete_check_2140.sql added the five argument form,
-- which takes the delete check's fingerprint and refuses when the consequence
-- moved, and kept the four argument form for the release before. Every Worker
-- deployed since #2241 (live 2026-10-16) calls only the five argument form
-- (routes/api/partner-delete.ts passes p_expected), and on production no other
-- function's source calls delete_partner_config (measured read only, 2026-10-16).
-- So a delete can no longer skip the reviewed consequence.
--
-- No data changes: this removes a function, not a row.

DROP FUNCTION IF EXISTS public.delete_partner_config(uuid, uuid, uuid, text);

COMMENT ON FUNCTION public._delete_partner_config(uuid, uuid, uuid, text, jsonb) IS
  'The body of delete_partner_config (#2140, #2254). Internal: it is reached only through it.';
