# Phase 2 (#421) — field_presence_daily rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `field_presence_daily` rollup table + `refresh_field_presence_daily()` pg_cron refresh that aggregates the Phase 0 `workflow_executions.field_presence` booleans into per-day `(ran_count, present_count)` per `(workflow_id, field_path, is_test)`, so the Phase 3 detector reads cheap aggregates.

**Architecture:** One additive SQL migration cloning the proven `refresh_workflow_stats_daily` pattern (table + delete-then-insert refresh over a 2-day window using `jsonb_each` + RLS + statement_timeout=0 backfill + two cron schedules). Plus a hand-authored `field_presence_daily` type block in the generated `database.ts` (the live-schema regen is chicken-and-egg before prod apply) and a guard test that locks the hand-authored types AND the migration DDL to the same column set.

**Tech Stack:** PostgreSQL (Supabase) + pg_cron; TypeScript types in `apps/worker/src/types/database.ts`; Vitest guard under `apps/web` (the vitest project with node+fs).

## Global Constraints

- Migration is additive/expand-only: new table, function, policy, cron — no changes to existing objects. Backward-compatible per the expand/contract rule.
- Migration version: `20260629000001` (next unused; `ls supabase/migrations/` confirmed latest is `20260627000002`). If that filename already exists when you start, pick the next unused `YYYYMMDDNNNNNN` and update references.
- Applied to prod BY HAND (dashboard SQL editor + register in `supabase_migrations.schema_migrations`), never `supabase db push` from a laptop. The deploy pipeline only checks the migration is applied.
- `field_presence` stores JSON booleans only (Phase 0 invariant). The rollup only counts them; it never stores a value.
- Ships dark: `FIELD_PRESENCE_CAPTURE` is off, so `field_presence` is empty and the rollup is correct-but-empty until enabled.
- No read RPC in this phase (the Phase 3 detector reads the table directly via service_role).
- `database.ts` Tables and Functions are sorted alphabetically; insert the new blocks in alphabetical position.
- SQL migrations cannot be unit-tested in the worker Vitest suite (no database). The push pre-gate will flag the new migration as untested — that is a known false positive for SQL; the controller overrides with `SKIP_TEST_CHECK=1` at push time.

---

### Task 1: Migration — `field_presence_daily` table, refresh function, RLS, backfill, cron

**Files:**
- Create: `supabase/migrations/20260629000001_field_presence_daily.sql`

**Interfaces:**
- Produces: table `field_presence_daily (workflow_id uuid, field_path text, day date, is_test boolean, ran_count bigint, present_count bigint)` PK `(workflow_id, field_path, day, is_test)`; function `refresh_field_presence_daily(p_lookback_days integer DEFAULT 2) RETURNS void`; RLS policy `field_presence_daily_org`; cron jobs `refresh-field-presence-daily` and `refresh-field-presence-daily-full`.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260629000001_field_presence_daily.sql` with exactly:

```sql
-- Phase 2 (#421) of silent-output-field detection (#410). Daily rollup of the
-- Phase 0 workflow_executions.field_presence booleans, so the Phase 3 detector
-- reads small per-(workflow, field, day, is_test) aggregates instead of scanning
-- the daily-partitioned, 7-day-retention raw tables.
--
-- ran_count     = executions where the producing node ran (the field key was present)
-- present_count = executions where the field carried a value (the JSON boolean was true)
-- The gap (ran_count - present_count) is the Scout signal: ran but empty.
--
-- Clones the proven refresh_workflow_stats_daily pattern (delete-then-insert a
-- recent window, statement_timeout=0 backfill, pg_cron). Additive/expand-only.
-- Ships dark: field_presence is empty until FIELD_PRESENCE_CAPTURE is enabled, so
-- this rollup is correct-but-empty until then.

CREATE TABLE field_presence_daily (
  workflow_id    UUID    NOT NULL,
  field_path     TEXT    NOT NULL,
  day            DATE    NOT NULL,
  is_test        BOOLEAN NOT NULL,
  ran_count      BIGINT  NOT NULL DEFAULT 0,
  present_count  BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, field_path, day, is_test)
);

CREATE INDEX field_presence_daily_day_idx ON field_presence_daily (day);

-- Refresh: delete-then-insert a recent window. Idempotent and safe to re-run.
-- A large lookback doubles as the initial backfill. jsonb_each expands each
-- execution's presence map into one row per watched field; an execution with
-- NULL/'{}' field_presence contributes no rows, so ran_count only counts
-- executions where that field's node actually ran.
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM field_presence_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  INSERT INTO field_presence_daily (
    workflow_id, field_path, day, is_test, ran_count, present_count
  )
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
  GROUP BY
    we.workflow_id, je.key,
    (we.started_at AT TIME ZONE 'UTC')::date, we.is_test;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;

-- RLS: org-scoped via the workflows join (table has workflow_id, no
-- organization_id) — identical shape to workflow_stats_daily_org. The worker
-- (service_role) and pg_cron (postgres) both bypass RLS; this only gates direct
-- PostgREST reads by an authenticated user.
ALTER TABLE field_presence_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_presence_daily_org" ON field_presence_daily
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );

-- Initial backfill. SET LOCAL statement_timeout = 0 so the migration won't be
-- killed at the 8s default. With the flag off this is near-instant (no rows).
DO $$
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM refresh_field_presence_daily(90);
END;
$$;

-- Incremental refresh every 5 minutes — 2-day lookback covers UTC day rollover
-- and late-completing executions.
SELECT cron.schedule(
  'refresh-field-presence-daily',
  '*/5 * * * *',
  $$SELECT refresh_field_presence_daily(2)$$
);

-- Daily full refresh covering 90 days at 03:50 UTC (staggered after
-- refresh-workflow-stats-daily-full at 03:45). Catches drift from cron blips.
SELECT cron.schedule(
  'refresh-field-presence-daily-full',
  '50 3 * * *',
  $$SELECT refresh_field_presence_daily(90)$$
);
```

- [ ] **Step 2: Verify the SQL against the template (no DB to run it)**

There is no local database, so the check is a structural diff against the proven template, not an execution:

Run: `diff <(sed -n '14,128p' supabase/migrations/20260515000001_workflow_stats_daily_rollup.sql) supabase/migrations/20260629000001_field_presence_daily.sql || true`
Expected: differences are confined to the table/column names, the `jsonb_each` expansion + `present_count` FILTER, the RLS policy, the cron job names, and the 03:50 schedule — the window logic, `statement_timeout=0` backfill, and grant shape match the template. Confirm by eye that:
- The PK is `(workflow_id, field_path, day, is_test)`.
- `count(*) FILTER (WHERE je.value = 'true'::jsonb)` is the present_count.
- `we.field_presence IS NOT NULL` guards the LATERAL join.
- Cron job names do not collide with existing ones (`grep -rn "cron.schedule" supabase/migrations/ | grep -i field` returns only this file).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629000001_field_presence_daily.sql
git commit -m "feat(db): field_presence_daily rollup + pg_cron refresh (#421)"
```

(The pre-commit hook runs typecheck + lint; a `.sql`-only change does not affect either. If a push gate later flags the migration as untested, that is the known SQL false positive — the controller handles it at push time.)

---

### Task 2: Hand-authored `database.ts` types + guard test locking types to the migration

**Files:**
- Modify: `apps/worker/src/types/database.ts` (insert `field_presence_daily` table block before `folders:` ~line 519; insert `refresh_field_presence_daily` function block before `refresh_workflow_stats_daily:` ~line 1803)
- Create: `apps/web/src/lib/__tests__/field-presence-daily-types.test.ts`

**Interfaces:**
- Consumes: the migration file from Task 1 (`supabase/migrations/20260629000001_field_presence_daily.sql`).
- Produces: typed `Database['public']['Tables']['field_presence_daily']` and `Database['public']['Functions']['refresh_field_presence_daily']`; a guard test that fails if the hand-authored type columns and the migration DDL columns ever diverge.

- [ ] **Step 1: Write the failing guard test**

Create `apps/web/src/lib/__tests__/field-presence-daily-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

// The hand-authored field_presence_daily type block must match the migration
// DDL exactly. The CI "DB types regenerated" job only checks database.ts is in
// the same diff as a migration; the nightly drift check validates against prod
// only AFTER the migration is applied by hand. This guard catches drift at PR
// time instead. (#421)

const EXPECTED_COLUMNS = [
  'workflow_id',
  'field_path',
  'day',
  'is_test',
  'ran_count',
  'present_count',
] as const

const MIGRATION = path.join(
  REPO_ROOT,
  'supabase/migrations/20260629000001_field_presence_daily.sql',
)
const DATABASE_TYPES = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

function sliceBlock(src: string, header: string): string {
  const start = src.indexOf(header)
  if (start === -1) return ''
  // From the header to the next sibling table key at the same indent.
  const after = src.slice(start + header.length)
  const end = after.search(/\n {6}[a-z_]+: \{/)
  return end === -1 ? after : after.slice(0, end)
}

describe('field_presence_daily migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  it('creates the table with exactly the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`))
    }
  })

  it('aggregates present_count as the JSON-true filter', () => {
    expect(sql).toContain("count(*) FILTER (WHERE je.value = 'true'::jsonb)")
  })

  it('schedules both cron refreshes', () => {
    expect(sql).toContain("'refresh-field-presence-daily'")
    expect(sql).toContain("'refresh-field-presence-daily-full'")
  })
})

describe('field_presence_daily database.ts types', () => {
  const types = readFileSync(DATABASE_TYPES, 'utf8')
  const block = sliceBlock(types, 'field_presence_daily: {')

  it('has a field_presence_daily table block', () => {
    expect(block.length).toBeGreaterThan(0)
  })

  it('Row declares exactly the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(block).toMatch(new RegExp(`\\b${col}\\b`))
    }
  })

  it('registers the refresh function type', () => {
    expect(types).toContain('refresh_field_presence_daily: {')
  })
})
```

- [ ] **Step 2: Run the guard test to verify it fails**

Run: `cd apps/web && pnpm test -- field-presence-daily-types.test.ts`
Expected: the `database.ts types` describe block FAILS (`block.length` is 0 / columns not found) because the type block is not authored yet. The `migration` describe block should already PASS (Task 1 created the SQL).

- [ ] **Step 3: Hand-author the table type block**

In `apps/worker/src/types/database.ts`, insert this block immediately before the `folders: {` table key (keep alphabetical order; match the existing 6-space indentation and the `Row`/`Insert`/`Update`/`Relationships` shape used by `workflow_stats_daily`):

```ts
      field_presence_daily: {
        Row: {
          day: string
          field_path: string
          is_test: boolean
          present_count: number
          ran_count: number
          workflow_id: string
        }
        Insert: {
          day: string
          field_path: string
          is_test: boolean
          present_count?: number
          ran_count?: number
          workflow_id: string
        }
        Update: {
          day?: string
          field_path?: string
          is_test?: boolean
          present_count?: number
          ran_count?: number
          workflow_id?: string
        }
        Relationships: []
      }
```

- [ ] **Step 4: Hand-author the function type block**

In `apps/worker/src/types/database.ts`, insert this block immediately before the `refresh_workflow_stats_daily: {` function key (alphabetical; match the shape of `refresh_workflow_stats_daily`):

```ts
      refresh_field_presence_daily: {
        Args: { p_lookback_days?: number }
        Returns: undefined
      }
```

- [ ] **Step 5: Run the guard test to verify it passes**

Run: `cd apps/web && pnpm test -- field-presence-daily-types.test.ts`
Expected: PASS — both describe blocks green (migration + database.ts types).

- [ ] **Step 6: Typecheck the worker to confirm the inserted types are well-formed**

Run: `pnpm --filter worker typecheck`
Expected: PASS — no syntax error from the inserted blocks.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/types/database.ts apps/web/src/lib/__tests__/field-presence-daily-types.test.ts
git commit -m "feat(types): hand-authored field_presence_daily types + drift guard (#421)"
```

---

## Self-Review

**Spec coverage:**
- Table `field_presence_daily` with the 6 columns + PK + day index → Task 1.
- `refresh_field_presence_daily` delete-then-insert over 2-day window with `jsonb_each`, `ran_count`/`present_count` semantics → Task 1.
- RLS org policy mirroring `workflow_stats_daily_org` → Task 1.
- `statement_timeout=0` backfill DO block → Task 1.
- Incremental + daily-full cron → Task 1.
- No read RPC (spec decision 1) → not built; confirmed absent.
- Fan-out narrowing deferred (spec decision 2) → straightforward `jsonb_each` shipped; not narrowed.
- Hand-authored DB types (spec decision 3) → Task 2 + drift guard.
- Migration applied by hand / next-unused version → Global Constraints + Task 1.

**Placeholder scan:** none — full SQL, full type blocks, full test, exact commands.

**Type consistency:** column set `{workflow_id, field_path, day, is_test, ran_count, present_count}` is identical across the migration DDL (Task 1), the `database.ts` Row/Insert/Update blocks (Task 2), and the guard's `EXPECTED_COLUMNS` (Task 2). Function name `refresh_field_presence_daily` and signature `(p_lookback_days?: number) → undefined` match between the migration and the function type block.

**Note on TDD shape:** the SQL migration (Task 1) has no executable unit test (no local DB); its correctness is gated by the structural diff (Task 1 Step 2), the guard test that parses the migration (Task 2), the task review, and the post-apply runbook in the spec. The genuine red→green TDD cycle is the Task 2 guard test.
