-- The contract half of expand/contract: drop the ungated expiry procedures (#1145).
--
-- `20260903210000` repointed both destructive jobs at the GATED procedures and
-- deliberately left the superseded pair in place, unscheduled, for one release
-- per ADR 0007. This is the half of expand/contract that routinely never
-- happens, which is why it had its own issue.
--
-- WHY THEY ARE WORTH REMOVING RATHER THAN LEAVING HARMLESS. Each one deletes a
-- day of execution history WITHOUT consulting the archive. They are unscheduled
-- and nothing calls them, so they are inert today, and inert is exactly how they
-- survive: the next person looking for "the procedure that drops expired
-- partitions" finds a name that reads like the right one and does not check
-- whether it asks the gate first (L29, L346).
--
-- VERIFIED BEFORE DROPPING, on production 2026-09-10:
--   0 cron jobs reference either name
--   nothing in apps/ calls them outside tests that assert their ABSENCE from
--   the cron commands, which is a check on the command text and stays valid
--
-- `drop_expired_execution_partitions` goes with them: it is the inner function
-- the _safe wrapper called, so leaving it would keep the ungated delete
-- reachable under a slightly different name, which is the same trap one step
-- along.
--
-- The gated pair, which every job now calls and which this does NOT touch:
--   truncate_verified_execution_partitions
--   drop_verified_execution_partitions

DROP PROCEDURE IF EXISTS public.truncate_expired_execution_partitions(integer);
DROP PROCEDURE IF EXISTS public.drop_expired_execution_partitions_safe(integer, integer);
DROP FUNCTION  IF EXISTS public.drop_expired_execution_partitions(integer);
