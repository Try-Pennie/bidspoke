-- Manual one-time op (NOT a migration). 2026-06-01.
-- Reclaim disk: drop the last MONTHLY partition (execution_steps_2026_05 ~17 GB
-- + workflow_executions_2026_05 ~3.2 GB). It can't be partition-dropped by the
-- 7-day purge cron until ~June 8 (whole-range rule), but the data volume is at
-- 24.7/28.5 GB used (3.7 GB free, Micro tier) with auto-expand ~1-2 days out.
-- Dropping now frees ~20 GB instantly with zero temp space. Cost: loses the
-- May 25-31 in-window debug detail (4.57M steps). Daily rollups in
-- workflow_stats_daily are frozen and survive.
--
-- Sequence mirrors drop_expired_execution_partitions(): drop the CHILD
-- (execution_steps) partition first, then the PARENT (workflow_executions),
-- DETACH before DROP so the cross-partition FK dependency doesn't block it
-- (the 5/18 "other objects depend on it" gotcha). ANALYZE after to refresh
-- stats and avoid the 5/18 bad-plan statement-timeout aftershock.
--
-- Run as ONE batch (lock_timeout persists for the session). If a DETACH aborts
-- with "canceling statement due to lock_timeout", a long read held the table —
-- just re-run; the writes go to June partitions and are never blocked for long.

SET lock_timeout = '5s';

-- Child first.
ALTER TABLE execution_steps DETACH PARTITION public.execution_steps_2026_05;
DROP TABLE IF EXISTS public.execution_steps_2026_05;

-- Parent second.
ALTER TABLE workflow_executions DETACH PARTITION public.workflow_executions_2026_05;
DROP TABLE IF EXISTS public.workflow_executions_2026_05;

-- Refresh planner stats on the now-modified partitioned parents.
ANALYZE execution_steps;
ANALYZE workflow_executions;
