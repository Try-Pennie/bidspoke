# Phase 2 (#421) — `field_presence_daily` rollup + pg_cron

> Implements Phase 2 of the silent-output-field detection milestone (#410).
> Builds on Phase 0 (#419, the `workflow_executions.field_presence` jsonb column)
> and Phase 1 (#420, the watched-field derivation that fills it when the flag is
> on). Clones the existing `refresh_workflow_stats_daily` rollup pattern.

## Goal

Materialize a cheap per-day summary of the Phase 0 presence booleans so the Phase
3 detector reads small aggregates instead of scanning the daily-partitioned,
7-day-retention raw tables. One row per `(workflow_id, field_path, day, is_test)`
with two counts: how often the producing node ran, and how often the watched
field carried a value. The gap between them is the Scout signal ("ran but empty").

Phase 2 is the rollup + scheduled refresh only. No detector, no alerts (Phase 3).
No read RPC (the detector reads the table directly). Ships dark: `field_presence`
is empty until `FIELD_PRESENCE_CAPTURE` is enabled, so the rollup is correct-but-
empty until then.

## Components

### Table `field_presence_daily`

```
workflow_id    UUID    NOT NULL
field_path     TEXT    NOT NULL
day            DATE    NOT NULL
is_test        BOOLEAN NOT NULL
ran_count      BIGINT  NOT NULL DEFAULT 0   -- executions where the node ran (key present)
present_count  BIGINT  NOT NULL DEFAULT 0   -- executions where the field carried a value (bool true)
PRIMARY KEY (workflow_id, field_path, day, is_test)
```
Index on `day` (mirrors `workflow_stats_daily_day_idx`), for the daily-window
delete and the detector's day-range reads.

`is_test` is kept as a dimension (not filtered out at rollup time) so the Phase 3
detector can read `is_test = false` while test runs remain available if ever
needed. This mirrors `workflow_stats_daily`.

### Refresh function `refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)`

Delete-then-insert a recent window (idempotent, safe to re-run; a large lookback
doubles as the backfill — same contract as `refresh_workflow_stats_daily`):

```sql
DELETE FROM field_presence_daily WHERE day >= (CURRENT_DATE - p_lookback_days);

INSERT INTO field_presence_daily (workflow_id, field_path, day, is_test, ran_count, present_count)
SELECT
  we.workflow_id,
  je.key,
  (we.started_at AT TIME ZONE 'UTC')::date,
  we.is_test,
  count(*),
  count(*) FILTER (WHERE je.value = 'true'::jsonb)
FROM workflow_executions we
CROSS JOIN LATERAL jsonb_each(we.field_presence) AS je(key, value)
WHERE we.started_at >= (CURRENT_DATE - p_lookback_days)::timestamptz
  AND we.started_at <  (CURRENT_DATE + 1)::timestamptz
  AND we.field_presence IS NOT NULL
GROUP BY we.workflow_id, je.key, (we.started_at AT TIME ZONE 'UTC')::date, we.is_test;
```

Notes:
- `CROSS JOIN LATERAL jsonb_each(...)` expands each execution's presence map into
  one row per watched field. An execution with `field_presence = NULL` or `'{}'`
  contributes no rows (the `IS NOT NULL` guard plus `jsonb_each('{}')` yielding
  zero rows), so `ran_count` only counts executions where that field's node ran.
- `je.value = 'true'::jsonb` is the boolean test for "field carried a value";
  the Phase 0 writer stores only JSON booleans, so this is exact.
- Window/day logic copied verbatim from `refresh_workflow_stats_daily` so both
  rollups agree on the UTC day boundary and the 2-day late-completion window.

### RLS

Enable RLS and add an org-scoped policy via the `workflows` join, identical in
shape to `workflow_stats_daily_org` (the table has `workflow_id`, no
`organization_id`). The worker and the pg_cron refresh both bypass RLS
(service_role / postgres), so only direct PostgREST reads by an authenticated
user are gated.

### Backfill + cron

- Backfill: a `DO` block that `set_config('statement_timeout','0',true)` then
  `PERFORM refresh_field_presence_daily(90)`. With the flag off this is near-
  instant (no rows), but it keeps the migration identical in shape to the
  proven one and makes it self-backfilling once data exists.
- `cron.schedule('refresh-field-presence-daily', '*/5 * * * *', refresh(2))`.
- `cron.schedule('refresh-field-presence-daily-full', '50 3 * * *', refresh(90))`
  (03:50 UTC, staggered after the existing stats-daily-full at 03:45).
- Grants: `EXECUTE` on `refresh_field_presence_daily(INTEGER)` to `service_role`.

## Decisions (recorded)

1. **No read RPC in Phase 2.** Unlike `workflow_stats_rollup` (which the dashboard
   calls), nothing reads `field_presence_daily` until the Phase 3 detector, which
   runs in the worker with the service_role key and can query the table directly.
   Adding an RPC now would be speculative.
2. **Ship the straightforward `jsonb_each` refresh; defer fan-out narrowing.** The
   issue flags that `jsonb_each` expansion could be heavy. With the flag off there
   is nothing to expand, so the cost is unmeasurable today. #432 measures it during
   the dark run; only if real numbers show the refresh exceeding sub-second do we
   narrow to a known watched-key set. Do not pre-optimize.
3. **Hand-author the DB types.** The CI "DB types regenerated with schema
   migrations" job requires `field_presence_daily` in
   `apps/worker/src/types/database.ts`, which is generated from the live prod
   schema (chicken-and-egg, same as Phase 0). Hand-write the `Row`/`Insert`/
   `Update` block (deterministic format) so the PR is self-contained and CI-green
   before the migration is applied to prod.

## Migration + deploy

- File: `supabase/migrations/20260629000001_field_presence_daily.sql` (next unused
  version; `ls supabase/migrations/` confirmed `20260627000002` is the latest).
- Expand/contract safe: purely additive (new table, function, policy, cron) — no
  changes to existing objects.
- Applied to prod BY HAND (Supabase dashboard SQL editor + register in
  `supabase_migrations.schema_migrations`, then `gh run rerun <id> --failed`).
  Never `supabase db push` from a laptop. The deploy pipeline only checks the
  migration is applied.

## Testing / verification

SQL migrations cannot be unit-tested in the worker Vitest suite (no database).
Verification is:
- SQL review of the refresh function against the `field_presence` shape (booleans
  only) and the `workflow_stats_daily` template it clones.
- A typed read path: the hand-authored `field_presence_daily` type block must
  match the table DDL (column names, nullability) so a future Phase 3 query is
  typed.
- After Dan applies it: confirm the cron jobs are registered
  (`cron.job`) and `refresh_field_presence_daily(2)` runs without error and
  produces zero rows while the flag is off (sanity that the SQL is valid against
  the real column). The real fan-out/latency gate is #432, run once the flag is
  briefly enabled.

## Non-negotiables

- Additive/expand-only; existing objects untouched.
- Detector reads ONLY this rollup, never raw `execution_steps` (carried into Phase
  3, but the table is designed for it: small, indexed by `day`, org-scoped).
- No values ever stored — `field_presence` is booleans only (Phase 0 invariant),
  and this rollup only counts them.
