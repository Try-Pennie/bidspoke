-- Drop service_presets (#2638, the contract step after #2338 build PR 14).
--
-- The expand half is live: #2639 (merged 2026-10-22) retired HTTP Services
-- presets, removing the /api/service-presets routes, the Integrations page
-- section and the Webhook step's reading of user presets, so no code reads or
-- writes the table (docs/adr/0007-expand-contract-migrations.md).
--
-- Measured on production (read only, 2026-10-27): 0 rows, and no database
-- function names it. Its only dependents are its own primary key, unique key,
-- foreign key to organizations and RLS policy, which go with it.
--
-- The table held no rows when the drop was decided, so nothing is copied first.
-- Should a row have appeared since, the migration refuses rather than destroy
-- it: the row is then copied out and the drop decided again (#2638).

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.service_presets') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.service_presets' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'drop service_presets (#2638): it holds % row(s), so nothing was dropped; copy them out, then run this again', v_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.service_presets;
