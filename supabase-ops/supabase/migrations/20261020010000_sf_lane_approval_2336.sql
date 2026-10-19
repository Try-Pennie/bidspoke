-- Dan's approval of the ops Salesforce lane for the trypennie org (#2336,
-- phase 6 of #1689, Decision 11).
--
-- WHY. sf_pool_caps, sf_bootstrap_caps and sf_purpose_caps are STATED, NEVER
-- DEFAULTED (L72): until a row exists, acquire_sf_lease refuses every ops
-- Salesforce call by name (sf_cap_unset, sf_purpose_cap_unset), and
-- service_role may only read the three tables, so a number arrives only by a
-- migration a person reviews. Dan approved the numbers on 2026-10-19; the
-- decision is recorded on #2336 ("Decision 11, the ops Salesforce lane
-- package", posted 2026-10-19 17:48:41 UTC), which is where approved_at comes
-- from. Phase 0 measured a limit of 25 long requests at once, a bidding peak of
-- 12 and a day of 474,747 calls used of 1,680,000.
--
-- WHAT. Rows only, for the trypennie org, every one on the nil uuid (a
-- Salesforce org's row, held there by each table's lane CHECK):
--   sf_pool_caps       00DDp00000170r6MAA: cap 3 at once, workflow_share 2 (so
--                      one lane always stays free for connection checks, the
--                      limits reading and lookups), budget_floor 250,000
--                      remaining daily calls (about 15%). The 18 character id,
--                      read from the Organization record on 2026-10-19 (Pennie,
--                      Unlimited Edition, not a sandbox); the 15 character form
--                      Phase 0 recorded is refused by the CHECK, and would key a
--                      second pool if it were not.
--   sf_bootstrap_caps  trypennie.my.salesforce.com, cap 1: the first verify of
--                      a new connection can measure its org.
--   sf_purpose_caps    share 1 each for lookup, verify, connection_check and
--                      sf_limits. reconnect was retired (#2503) and has no share.
-- Partner orgs (tpl2, achieve) are approved one at a time, by a migration of
-- their own, when the first workflow using that org is ported.
--
-- SAFE TO RE-RUN, NEVER AN OVERWRITE. A row already holding exactly these
-- values is left as it is. A row for this org, host or purpose holding any
-- other value (a number, approved_at or approved_by) RAISES naming the row and
-- what it holds, and nothing is written: an approval is changed only by a
-- deliberate later migration, never by replaying this one. A missing row is
-- inserted.
--
-- PRIVILEGES UNCHANGED. No GRANT or REVOKE here: service_role keeps SELECT
-- only on the three tables, as 20261017220000 and 20261018090000 left it.
--
-- SAFE BEFORE OR AFTER ITS CODE (L640). Inserts only, into tables that exist,
-- read by acquire_sf_lease, which is unchanged. The deployed code already
-- handles a granted lease (that is every test of the pool), and the lock taken
-- below lets acquire_sf_lease keep reading while it is held.
--
-- Additive only (ADR 0007): three tables gain rows, no object changes.
-- Guarded by supabase-ops/supabase/tests/sf_lane_approval.test.sql.

SET LOCAL lock_timeout = '5s';

-- One statement, so it is one transaction however this file is run (the CLI
-- wraps it in one; a psql replay does not), and the three tables are held from
-- the reads to the inserts, so no other writer can slip a row in between.
DO $approve$
DECLARE
  c_org  CONSTANT text := '00DDp00000170r6MAA';
  c_host CONSTANT text := 'trypennie.my.salesforce.com';
  c_lane CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  c_at   CONSTANT timestamptz := '2026-10-19 17:48:41+00';
  c_by   CONSTANT text := 'Dan Wright (Decision 11, #2336)';
  v_pool public.sf_pool_caps%ROWTYPE;
  v_boot public.sf_bootstrap_caps%ROWTYPE;
  v_share public.sf_purpose_caps%ROWTYPE;
  v_purpose text;
BEGIN
  SET LOCAL lock_timeout = '5s';
  -- SHARE ROW EXCLUSIVE stops every other writer and no reader.
  LOCK TABLE public.sf_pool_caps, public.sf_bootstrap_caps, public.sf_purpose_caps IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_pool FROM public.sf_pool_caps WHERE sf_org_id = c_org;
  IF FOUND AND (v_pool.organization_id, v_pool.cap, v_pool.workflow_share, v_pool.budget_floor, v_pool.approved_at, v_pool.approved_by)
      IS DISTINCT FROM (c_lane, 3, 2, 250000, c_at, c_by) THEN
    RAISE EXCEPTION 'sf lane approval (#2336): sf_pool_caps already holds org % as cap %, workflow_share %, budget_floor %, approved % by %, not this approval (cap 3, workflow_share 2, budget_floor 250000); nothing was changed',
      c_org, v_pool.cap, v_pool.workflow_share, v_pool.budget_floor, v_pool.approved_at, v_pool.approved_by
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'An approval is changed only by a later migration of its own. This one never overwrites.';
  END IF;

  SELECT * INTO v_boot FROM public.sf_bootstrap_caps WHERE instance_host = c_host;
  IF FOUND AND (v_boot.organization_id, v_boot.cap, v_boot.approved_at, v_boot.approved_by) IS DISTINCT FROM (c_lane, 1, c_at, c_by) THEN
    RAISE EXCEPTION 'sf lane approval (#2336): sf_bootstrap_caps already holds host % as cap %, approved % by %, not this approval; nothing was changed',
      c_host, v_boot.cap, v_boot.approved_at, v_boot.approved_by
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'An approval is changed only by a later migration of its own. This one never overwrites.';
  END IF;

  FOREACH v_purpose IN ARRAY ARRAY['lookup', 'verify', 'connection_check', 'sf_limits'] LOOP
    SELECT * INTO v_share FROM public.sf_purpose_caps WHERE sf_org_id = c_org AND purpose = v_purpose;
    IF FOUND AND (v_share.organization_id, v_share.share, v_share.approved_at, v_share.approved_by) IS DISTINCT FROM (c_lane, 1, c_at, c_by) THEN
      RAISE EXCEPTION 'sf lane approval (#2336): sf_purpose_caps already holds org % purpose % as share %, approved % by %, not this approval (share 1); nothing was changed',
        c_org, v_purpose, v_share.share, v_share.approved_at, v_share.approved_by
        USING ERRCODE = 'object_not_in_prerequisite_state',
              HINT = 'An approval is changed only by a later migration of its own. This one never overwrites.';
    END IF;
  END LOOP;

  -- Every existing row matches, so only the missing ones are written.
  INSERT INTO public.sf_pool_caps (sf_org_id, organization_id, cap, workflow_share, budget_floor, approved_at, approved_by)
  VALUES (c_org, c_lane, 3, 2, 250000, c_at, c_by)
  ON CONFLICT (sf_org_id) DO NOTHING;

  INSERT INTO public.sf_bootstrap_caps (instance_host, organization_id, cap, approved_at, approved_by)
  VALUES (c_host, c_lane, 1, c_at, c_by)
  ON CONFLICT (instance_host) DO NOTHING;

  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, organization_id, share, approved_at, approved_by)
  SELECT c_org, p, c_lane, 1, c_at, c_by FROM unnest(ARRAY['lookup', 'verify', 'connection_check', 'sf_limits']) AS p
  ON CONFLICT (sf_org_id, purpose) DO NOTHING;
END
$approve$;
