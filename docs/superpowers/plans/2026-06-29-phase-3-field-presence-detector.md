# Phase 3 (#422) — Field-presence detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a log-only detector that reads `field_presence_daily` and logs two failure shapes — Tier-1 drought (a normally-present field collapses today) and Tier-2 day-one-dead (a field never present despite many runs) — without sending anything.

**Architecture:** One new `apps/worker/src/lib/field-presence-anomaly.ts` with pure detection functions (unit-tested), pure row-walking finders (unit-tested), and two thin orchestrators that read the rollup and `console.log` intended detections. Tier-1 is wired into the hourly `0 * * * *` cron, Tier-2 into the daily `0 13 * * *` batch. Mirrors `volume-anomaly.ts`.

**Tech Stack:** TypeScript (worker engine), Vitest. No new dependencies, no schema change, no KV/Slack this phase.

## Global Constraints

- TypeScript strict; avoid `any`. Straight quotes only; no em dashes anywhere incl. comments; no comments unless logic is non-obvious.
- Worker tests: `cd apps/worker && pnpm test`. Typecheck: `pnpm --filter worker typecheck`.
- Log-only: NO Slack message, NO DB write, NO KV write this phase. The detector only `console.log`s structured events.
- Reads ONLY `field_presence_daily` (the Phase 2 rollup), `is_test = false`. Never raw `execution_steps`.
- Runs across all active, non-deleted workflows (not just Slack-configured orgs) for dark-run coverage.
- The stability gate (`STABLE_MEAN_MIN` + `STABLE_STDDEV_MAX` + `MIN_TODAY_SAMPLE`) is load-bearing: it is what stops normal no-bid/no-debt nulls from firing. Keep it.
- Thresholds are provisional, named constants, validated in the dark run.

---

### Task 1: Pure detection functions + thresholds

**Files:**
- Create: `apps/worker/src/lib/field-presence-anomaly.ts`
- Test: `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts`

**Interfaces:**
- Produces: `dailyRate(ran, present): number`, `mean(xs): number`, `stddev(xs): number`, `isStableBaseline(rates): boolean`, `detectDrought(baselineRates, todayRate, todayRan): { mean: number; stddev: number; todayRate: number } | null`, `detectDayOneDead(windowRan, windowPresent, everHealthy): boolean`, and the threshold constants.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  dailyRate, mean, stddev, isStableBaseline, detectDrought, detectDayOneDead,
  STABLE_MEAN_MIN, MIN_TODAY_SAMPLE, DEAD_MIN_RUNS,
} from '../field-presence-anomaly'

describe('numeric helpers', () => {
  it('dailyRate is present/ran', () => {
    expect(dailyRate(100, 99)).toBeCloseTo(0.99)
  })
  it('mean of one element', () => {
    expect(mean([0.99])).toBeCloseTo(0.99)
  })
  it('stddev is zero for constant input', () => {
    expect(stddev([0.99, 0.99, 0.99])).toBe(0)
  })
  it('stddev is population stddev', () => {
    expect(stddev([0, 1])).toBeCloseTo(0.5)
  })
})

describe('isStableBaseline', () => {
  it('true for high-mean low-variance with enough days', () => {
    expect(isStableBaseline([0.99, 1, 0.99, 1])).toBe(true)
  })
  it('false when too few days', () => {
    expect(isStableBaseline([1, 1])).toBe(false)
  })
  it('false when mean is below the stable floor', () => {
    expect(isStableBaseline([0.5, 0.5, 0.5, 0.5])).toBe(false)
  })
  it('false when variance is high (a variable no-bid field)', () => {
    expect(isStableBaseline([1, 0.2, 0.9, 0.3])).toBe(false)
  })
})

describe('detectDrought', () => {
  const STABLE = [1, 0.99, 1, 0.99, 1]
  it('fires when a stable field collapses today with enough runs', () => {
    const r = detectDrought(STABLE, 0.0, 100)
    expect(r).not.toBeNull()
    expect(r!.todayRate).toBe(0)
  })
  it('does NOT fire when today has too few runs', () => {
    expect(detectDrought(STABLE, 0.0, MIN_TODAY_SAMPLE - 1)).toBeNull()
  })
  it('does NOT fire for a variable (no-bid) baseline even at 0% today', () => {
    expect(detectDrought([1, 0.2, 0.9, 0.3], 0.0, 100)).toBeNull()
  })
  it('does NOT fire when today is still within the stable band', () => {
    expect(detectDrought(STABLE, 0.99, 100)).toBeNull()
  })
})

describe('detectDayOneDead', () => {
  it('fires for many runs, ~0 presence, never healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, false)).toBe(true)
  })
  it('does NOT fire if the field was ever healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, true)).toBe(false)
  })
  it('does NOT fire with too few runs', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS - 1, 0, false)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/lib/field-presence-anomaly.ts`:

```ts
// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import { MIN_BASELINE_DAYS } from './volume-anomaly'

export { MIN_BASELINE_DAYS }
export const BASELINE_MIN_DAY_RUNS = 10
export const STABLE_MEAN_MIN = 0.98
export const STABLE_STDDEV_MAX = 0.02
export const COLLAPSE_K = 4
export const MIN_TODAY_SAMPLE = 20
export const DEAD_WINDOW_DAYS = 7
export const DEAD_MIN_RUNS = 200
export const DEAD_MAX_RATE = 0.005

export function dailyRate(ran: number, present: number): number {
  return ran > 0 ? present / ran : 0
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

export function stddev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length
  return Math.sqrt(variance)
}

// A field is "stable" when it is essentially always present with low variance
// over enough days. Variable fields (no-bid, no-debt) have high variance and
// never qualify, so they never page.
export function isStableBaseline(rates: number[]): boolean {
  return (
    rates.length >= MIN_BASELINE_DAYS &&
    mean(rates) >= STABLE_MEAN_MIN &&
    stddev(rates) <= STABLE_STDDEV_MAX
  )
}

// Tier-1: a stable field whose today's rate falls well below its stable band,
// with enough runs today to judge. Returns the baseline stats on a hit.
export function detectDrought(
  baselineRates: number[],
  todayRate: number,
  todayRan: number,
): { mean: number; stddev: number; todayRate: number } | null {
  if (todayRan < MIN_TODAY_SAMPLE) return null
  if (!isStableBaseline(baselineRates)) return null
  const m = mean(baselineRates)
  const sd = stddev(baselineRates)
  if (todayRate < m - COLLAPSE_K * sd) {
    return { mean: m, stddev: sd, todayRate }
  }
  return null
}

// Tier-2: many runs over the window, presence rate ~0, and never healthy on any
// day. The "never healthy" guard is what distinguishes born-dead (Tier-2) from
// was-healthy-then-died (Tier-1's collapse).
export function detectDayOneDead(
  windowRan: number,
  windowPresent: number,
  everHealthy: boolean,
): boolean {
  if (windowRan < DEAD_MIN_RUNS) return false
  if (everHealthy) return false
  return dailyRate(windowRan, windowPresent) <= DEAD_MAX_RATE
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/field-presence-anomaly.ts apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts
git commit -m "feat(worker): field-presence detector pure functions (#422)"
```

---

### Task 2: Pure row-walking finders (`findDroughts`, `findDayOneDead`)

Group rollup rows by `(workflow_id, field_path)` and run the detectors. Pure, so fully testable without mocking Supabase.

**Files:**
- Modify: `apps/worker/src/lib/field-presence-anomaly.ts`
- Test: `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts`

**Interfaces:**
- Consumes: `dailyRate`, `detectDrought`, `detectDayOneDead`, the constants (Task 1).
- Produces:
  - `interface PresenceRow { workflow_id: string; field_path: string; day: string; ran_count: number; present_count: number }`
  - `interface DroughtHit { workflow_id: string; field_path: string; mean: number; stddev: number; today_rate: number; today_ran: number }`
  - `interface DeadHit { workflow_id: string; field_path: string; window_ran: number; window_present: number }`
  - `findDroughts(rows: PresenceRow[], today: string): DroughtHit[]`
  - `findDayOneDead(rows: PresenceRow[]): DeadHit[]`

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts` (add `findDroughts`, `findDayOneDead`, and the `PresenceRow` type to the import):

```ts
import type { PresenceRow } from '../field-presence-anomaly'
import { findDroughts, findDayOneDead, DEAD_MIN_RUNS as DMR } from '../field-presence-anomaly'

function row(wf: string, field: string, day: string, ran: number, present: number): PresenceRow {
  return { workflow_id: wf, field_path: field, day, ran_count: ran, present_count: present }
}

// Five stable baseline days then a collapsed today.
const DAYS = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27']
const TODAY = '2026-06-29'

describe('findDroughts', () => {
  it('flags a stable field that collapses today, and ignores a normal no-bid field', () => {
    const rows: PresenceRow[] = []
    for (const d of DAYS) {
      rows.push(row('wf1', 'scout.final', d, 100, 100))   // stable, always present
      rows.push(row('wf1', 'bid.amount', d, 100, 40))     // no-bid: ~40%, low rate -> not stable
    }
    rows.push(row('wf1', 'scout.final', TODAY, 80, 0))    // collapsed today, enough runs
    rows.push(row('wf1', 'bid.amount', TODAY, 80, 0))     // 0% today but never stable
    const hits = findDroughts(rows, TODAY)
    expect(hits.map((h) => h.field_path)).toEqual(['scout.final'])
  })

  it('does not flag when today has too few runs', () => {
    const rows: PresenceRow[] = DAYS.map((d) => row('wf1', 'scout.final', d, 100, 100))
    rows.push(row('wf1', 'scout.final', TODAY, 5, 0))   // below MIN_TODAY_SAMPLE
    expect(findDroughts(rows, TODAY)).toEqual([])
  })
})

describe('findDayOneDead', () => {
  it('flags a field with many runs and zero presence, never healthy', () => {
    const rows = [row('wf2', 'eligibility.final', '2026-06-28', DMR, 0)]
    const hits = findDayOneDead(rows)
    expect(hits.map((h) => h.field_path)).toEqual(['eligibility.final'])
  })

  it('does not flag a field that was healthy on some day', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-27', 100, 100),  // healthy day
      row('wf2', 'eligibility.final', '2026-06-28', DMR, 0),
    ]
    expect(findDayOneDead(rows)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts`
Expected: FAIL — `findDroughts`/`findDayOneDead`/`PresenceRow` not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/worker/src/lib/field-presence-anomaly.ts`:

```ts
export interface PresenceRow {
  workflow_id: string
  field_path: string
  day: string
  ran_count: number
  present_count: number
}

export interface DroughtHit {
  workflow_id: string
  field_path: string
  mean: number
  stddev: number
  today_rate: number
  today_ran: number
}

export interface DeadHit {
  workflow_id: string
  field_path: string
  window_ran: number
  window_present: number
}

function groupByField(rows: PresenceRow[]): Map<string, PresenceRow[]> {
  const groups = new Map<string, PresenceRow[]>()
  for (const r of rows) {
    const key = `${r.workflow_id} ${r.field_path}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }
  return groups
}

// Tier-1: per field, build a baseline from prior days with enough runs, take the
// most recent 7, and test today's partial rate against the stability gate.
export function findDroughts(rows: PresenceRow[], today: string): DroughtHit[] {
  const hits: DroughtHit[] = []
  for (const bucket of groupByField(rows).values()) {
    const todayRow = bucket.find((r) => r.day === today)
    if (!todayRow) continue
    const baselineRates = bucket
      .filter((r) => r.day < today && r.ran_count >= BASELINE_MIN_DAY_RUNS)
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-7)
      .map((r) => dailyRate(r.ran_count, r.present_count))
    const todayRate = dailyRate(todayRow.ran_count, todayRow.present_count)
    const result = detectDrought(baselineRates, todayRate, todayRow.ran_count)
    if (result) {
      hits.push({
        workflow_id: todayRow.workflow_id,
        field_path: todayRow.field_path,
        mean: result.mean,
        stddev: result.stddev,
        today_rate: result.todayRate,
        today_ran: todayRow.ran_count,
      })
    }
  }
  return hits
}

// Tier-2: per field, sum the window and check day-one-dead. A field is counted
// as "ever healthy" only on a day with enough runs to trust its rate.
export function findDayOneDead(rows: PresenceRow[]): DeadHit[] {
  const hits: DeadHit[] = []
  for (const bucket of groupByField(rows).values()) {
    let windowRan = 0
    let windowPresent = 0
    let everHealthy = false
    for (const r of bucket) {
      windowRan += r.ran_count
      windowPresent += r.present_count
      if (r.ran_count >= BASELINE_MIN_DAY_RUNS && dailyRate(r.ran_count, r.present_count) >= STABLE_MEAN_MIN) {
        everHealthy = true
      }
    }
    if (detectDayOneDead(windowRan, windowPresent, everHealthy)) {
      hits.push({
        workflow_id: bucket[0].workflow_id,
        field_path: bucket[0].field_path,
        window_ran: windowRan,
        window_present: windowPresent,
      })
    }
  }
  return hits
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/field-presence-anomaly.ts apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts
git commit -m "feat(worker): field-presence drought + day-one-dead finders (#422)"
```

---

### Task 3: Orchestrators + cron wiring

Read `field_presence_daily`, call the finders, `console.log` intended detections. Wire Tier-1 into the hourly cron and Tier-2 into the daily batch.

**Files:**
- Modify: `apps/worker/src/lib/field-presence-anomaly.ts`
- Modify: `apps/worker/src/index.ts` (import + two `ctx.waitUntil` additions)

**Interfaces:**
- Consumes: `findDroughts`, `findDayOneDead`, `DEAD_WINDOW_DAYS`, `MIN_BASELINE_DAYS`, `PresenceRow` (Task 2); `SupabaseClient`.
- Produces: `runFieldPresenceDroughtCheck(supabase: SupabaseClient): Promise<void>`, `runFieldPresenceDeadCheck(supabase: SupabaseClient): Promise<void>`.

- [ ] **Step 1: Write the orchestrators**

Append to `apps/worker/src/lib/field-presence-anomaly.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

const DAY_MS = 24 * 60 * 60 * 1000

// Active, non-deleted workflow ids. Log-only runs across all of them (not just
// Slack-configured orgs) for dark-run coverage; Phase 4 adds org/Slack scoping.
async function activeWorkflowIds(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from('workflows')
    .select('id')
    .eq('is_active', true)
    .is('deleted_at', null)
  return (data ?? []).map((w) => w.id as string)
}

async function readPresenceRows(
  supabase: SupabaseClient,
  workflowIds: string[],
  sinceDate: string,
): Promise<PresenceRow[]> {
  const { data } = await supabase
    .from('field_presence_daily')
    .select('workflow_id, field_path, day, ran_count, present_count')
    .in('workflow_id', workflowIds)
    .gte('day', sinceDate)
    .eq('is_test', false)
  return (data ?? []).map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
    day: r.day as string,
    ran_count: Number(r.ran_count),
    present_count: Number(r.present_count),
  }))
}

// Tier-1 (hourly). Logs intended pages; sends nothing this phase.
export async function runFieldPresenceDroughtCheck(supabase: SupabaseClient): Promise<void> {
  const workflowIds = await activeWorkflowIds(supabase)
  if (workflowIds.length === 0) return
  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(Date.now() - (MIN_BASELINE_DAYS + 8) * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const hits = findDroughts(rows, today)
  for (const h of hits) {
    console.log(JSON.stringify({ event: 'field_presence_drought', ...h }))
  }
  console.log(`[field-presence-drought] checked=${workflowIds.length} workflows hits=${hits.length}`)
}

// Tier-2 (daily). Logs the day-one-dead digest as one event; sends nothing.
export async function runFieldPresenceDeadCheck(supabase: SupabaseClient): Promise<void> {
  const workflowIds = await activeWorkflowIds(supabase)
  if (workflowIds.length === 0) return
  const since = new Date(Date.now() - DEAD_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const hits = findDayOneDead(rows)
  console.log(JSON.stringify({ event: 'field_presence_dead_digest', count: hits.length, fields: hits }))
}
```

- [ ] **Step 2: Verify the file typechecks**

Run: `pnpm --filter worker typecheck`
Expected: PASS (no `any`, imports resolve).

- [ ] **Step 3: Wire Tier-1 into the hourly cron**

In `apps/worker/src/index.ts`, add the import near the other lib imports (after the `volume-cliff` import line):

```ts
import { runFieldPresenceDroughtCheck, runFieldPresenceDeadCheck } from './lib/field-presence-anomaly'
```

In the `} else if (event.cron === '0 * * * *') {` branch (after the existing `runMatrixAudit` `ctx.waitUntil` block), add:

```ts
      ctx.waitUntil(
        runFieldPresenceDroughtCheck(supabase)
          .catch((e) => console.error('[field-presence-drought] failed:', e))
      )
```

- [ ] **Step 4: Wire Tier-2 into the daily batch**

In `apps/worker/src/index.ts`, in the `} else if (event.cron === '0 13 * * *') {` branch (alongside the existing `runVolumeAnomalyCheck(supabase)` `ctx.waitUntil`), add:

```ts
      ctx.waitUntil(
        runFieldPresenceDeadCheck(supabase)
          .catch((e) => console.error('[field-presence-dead] failed:', e))
      )
```

- [ ] **Step 5: Typecheck + full worker suite**

Run: `pnpm --filter worker typecheck && cd apps/worker && pnpm test`
Expected: PASS — typecheck clean, all tests green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/lib/field-presence-anomaly.ts apps/worker/src/index.ts
git commit -m "feat(worker): wire field-presence detector into cron (log-only) (#422)"
```

---

## Self-Review

**Spec coverage:**
- Tier-1 drought (stability gate: stable baseline + collapse + sample floor) → Task 1 (`detectDrought`/`isStableBaseline`) + Task 2 (`findDroughts`).
- Tier-2 day-one-dead (many runs, ~0 presence, never healthy) → Task 1 (`detectDayOneDead`) + Task 2 (`findDayOneDead`).
- Presence rate, no day-type split → `dailyRate`; no weekend/weekday logic anywhere.
- Single conservative sample floor → `MIN_TODAY_SAMPLE`, applied uniformly.
- Reads only `field_presence_daily`, `is_test=false`, active workflows → Task 3 (`readPresenceRows`/`activeWorkflowIds`).
- Log-only (no Slack/DB/KV) → Task 3 orchestrators only `console.log`.
- Tier-1 hourly, Tier-2 daily → Task 3 cron wiring.
- Cooldown/Slack/silence deferred to Phase 4 → not built; confirmed absent.

**Placeholder scan:** none — full code and exact commands throughout.

**Type consistency:** `PresenceRow`/`DroughtHit`/`DeadHit` shapes and the function signatures (`findDroughts(rows, today)`, `findDayOneDead(rows)`, `detectDrought(baselineRates, todayRate, todayRan)`, `detectDayOneDead(windowRan, windowPresent, everHealthy)`) are consistent across Tasks 1-3 and the orchestrators. Constants (`MIN_TODAY_SAMPLE`, `DEAD_MIN_RUNS`, `BASELINE_MIN_DAY_RUNS`, `STABLE_MEAN_MIN`, `DEAD_WINDOW_DAYS`, `MIN_BASELINE_DAYS`) are defined once in Task 1 and reused.

**Note:** the orchestrators (Task 3) are thin and not unit-tested, matching `volume-anomaly.ts` (whose `runVolumeAnomalyCheck` is likewise not unit-tested); their logic lives in the pure finders, which are fully tested in Task 2. The cron wiring is verified by typecheck + reading, as the scheduled handler is not unit-tested.
