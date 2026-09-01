// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import type { SupabaseClient } from '@supabase/supabase-js'
import { MIN_BASELINE_DAYS } from './volume-anomaly'
import { fetchAllPaged } from './paginate'

export { MIN_BASELINE_DAYS }
export const BASELINE_MIN_DAY_RUNS = 10
// Calibrated against the dark run, not chosen (#432). Measured over
// 2026-08-09..2026-09-01 with `npx tsx scripts/diagnose-field-presence.ts`:
// sweeping this floor from 0.98 down to 0.80 produced ZERO Tier-1 hits on all
// 24 days, while raising coverage from 104 to 117 of 144 (workflow, field)
// pairs. So the shipped 0.98 was buying no quiet, only blind spots. 0.90 sits
// on a plateau (0.92 and 0.90 both admit 112) and covers every stable-but-
// imperfect field the measurement found, the important one being Main Flow
// `pennie_or_eligibility.final` at 94.4% mean / 0.011 stddev: the Eligibility
// Scout field whose silent death is the incident this milestone was built
// after. At 0.98 a total Scout collapse could not have paged.
//
// STABLE_STDDEV_MAX is the gate that actually excludes variable no-bid fields,
// and it is deliberately unchanged.
export const STABLE_MEAN_MIN = 0.90
export const STABLE_STDDEV_MAX = 0.02
export const COLLAPSE_K = 4
export const COLLAPSE_FLOOR = 0.10
export const MIN_TODAY_SAMPLE = 20
export const DEAD_WINDOW_DAYS = 7
export const DEAD_MIN_RUNS = 200
// Also calibrated, not chosen (#432). The real 7-day distribution has an empty
// band: four fields resolve on exactly 0.0000% of runs (every one a genuinely
// broken reference, including #709), and the next-rarest real field sits at
// 0.2632%. The shipped 0.005 landed INSIDE the rare-but-real cluster rather
// than in the gap, so it called three legitimately-rare fields dead while
// exempting a fourth of the same kind at 0.679% (L172). 0.001 sits in the empty
// band with 2.6x margin below the nearest real field, and is deliberately not
// exactly zero so a chronically dead field that succeeds a handful of times in
// a large sample is still caught.
export const DEAD_MAX_RATE = 0.001

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

/**
 * Every threshold the detector consults, injectable (#432).
 *
 * These exist so the dark-run validation can ask "what would a different mean
 * floor have paged over the same real days" by driving the SHIPPED predicate
 * with a different number, instead of a sweep reimplementing the rule beside
 * it, which is a second definition that drifts in whichever direction flatters
 * the argument (L107). Every field is optional and falls back to the shipped
 * constant, so no caller changes when a threshold moves.
 */
export interface PresenceThresholds {
  minBaselineDays?: number
  stableMeanMin?: number
  stableStddevMax?: number
  collapseK?: number
  collapseFloor?: number
  minTodaySample?: number
  deadMinRuns?: number
  deadMaxRate?: number
}

interface ResolvedThresholds {
  minBaselineDays: number
  stableMeanMin: number
  stableStddevMax: number
  collapseK: number
  collapseFloor: number
  minTodaySample: number
  deadMinRuns: number
  deadMaxRate: number
}

function resolve(t: PresenceThresholds = {}): ResolvedThresholds {
  // ?? not ||, so an override of 0 (a deliberate "exactly zero" ceiling) is
  // honoured rather than falling back to the shipped constant.
  return {
    minBaselineDays: t.minBaselineDays ?? MIN_BASELINE_DAYS,
    stableMeanMin: t.stableMeanMin ?? STABLE_MEAN_MIN,
    stableStddevMax: t.stableStddevMax ?? STABLE_STDDEV_MAX,
    collapseK: t.collapseK ?? COLLAPSE_K,
    collapseFloor: t.collapseFloor ?? COLLAPSE_FLOOR,
    minTodaySample: t.minTodaySample ?? MIN_TODAY_SAMPLE,
    deadMinRuns: t.deadMinRuns ?? DEAD_MIN_RUNS,
    deadMaxRate: t.deadMaxRate ?? DEAD_MAX_RATE,
  }
}

// A field is "stable" when it is essentially always present with low variance
// over enough days. Variable fields (no-bid, no-debt) have high variance and
// never qualify, so they never page.
export function isStableBaseline(rates: number[], thresholds?: PresenceThresholds): boolean {
  const t = resolve(thresholds)
  return (
    rates.length >= t.minBaselineDays &&
    mean(rates) >= t.stableMeanMin &&
    stddev(rates) <= t.stableStddevMax
  )
}

// Tier-1: a stable field whose today's rate falls well below its stable band,
// with enough runs today to judge. Returns the baseline stats on a hit.
export function detectDrought(
  baselineRates: number[],
  todayRate: number,
  todayRan: number,
  thresholds?: PresenceThresholds,
): { mean: number; stddev: number; todayRate: number } | null {
  const t = resolve(thresholds)
  if (todayRan < t.minTodaySample) return null
  if (!isStableBaseline(baselineRates, thresholds)) return null
  const m = mean(baselineRates)
  const sd = stddev(baselineRates)
  const margin = Math.max(t.collapseK * sd, t.collapseFloor)
  if (todayRate < m - margin) {
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
  thresholds?: PresenceThresholds,
): boolean {
  const t = resolve(thresholds)
  if (windowRan < t.deadMinRuns) return false
  if (everHealthy) return false
  return dailyRate(windowRan, windowPresent) <= t.deadMaxRate
}

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
    const key = `${r.workflow_id}|${r.field_path}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }
  return groups
}

// Tier-1: per field, build a baseline from prior days with enough runs, take the
// most recent 7, and test today's partial rate against the stability gate.
export function findDroughts(
  rows: PresenceRow[],
  today: string,
  thresholds?: PresenceThresholds,
): DroughtHit[] {
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
    const result = detectDrought(baselineRates, todayRate, todayRow.ran_count, thresholds)
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
export function findDayOneDead(rows: PresenceRow[], thresholds?: PresenceThresholds): DeadHit[] {
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
    if (detectDayOneDead(windowRan, windowPresent, everHealthy, thresholds)) {
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

// Drop any hit whose (workflow_id, field_path) is in the silenced set. The key is
// `${workflow_id} ${field_path}` (a space separator a field path cannot contain).
export function excludeSilenced<T extends { workflow_id: string; field_path: string }>(
  hits: T[],
  silenced: Set<string>,
): T[] {
  return hits.filter((h) => !silenced.has(`${h.workflow_id} ${h.field_path}`))
}

// Author-set silences for the active workflows. Keyed to match excludeSilenced.
// A read failure returns an empty set (log-only detector still logs everything).
async function readSilences(supabase: SupabaseClient, workflowIds: string[]): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('field_presence_silences')
    .select('workflow_id, field_path')
    .in('workflow_id', workflowIds)
  if (error) {
    console.error('[field-presence] silences read failed:', error)
    return new Set()
  }
  return new Set((data ?? []).map((r) => `${r.workflow_id as string} ${r.field_path as string}`))
}

const DAY_MS = 24 * 60 * 60 * 1000

// Active, non-deleted workflow ids. Log-only runs across all of them (not just
// Slack-configured orgs) for dark-run coverage; Phase 4 adds org/Slack scoping.
async function activeWorkflowIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (error) console.error('[field-presence] workflows read failed:', error)
  return (data ?? []).map((w) => w.id as string)
}

/**
 * The rollup rows for these workflows since `sinceDate`.
 *
 * Paged through `fetchAllPaged` with a stable total order (AUD-039). It
 * previously paged with a bare `.range()` and no ORDER BY, against a table the
 * 5-minute pg_cron refresh rewrites underneath it, so Postgres recomputed each
 * OFFSET against an independent scan and the pages skipped and duplicated rows.
 * That is quieter than a truncation: the detector still got ~the right NUMBER
 * of rows, so a dropped day looked like a field that simply had no traffic, and
 * a duplicated one distorted the very rates the thresholds are judged against.
 *
 * (workflow_id, field_path, day) is the table's primary key minus `is_test`,
 * which is filtered to a single value here, so it is a total order.
 *
 * A read failure THROWS rather than returning what it managed to collect: a
 * detector that judges "this field is dead" from a partial read would accuse a
 * healthy field on the strength of rows it never saw (L211, L215). The callers
 * log and skip the cycle.
 */
async function readPresenceRows(
  supabase: SupabaseClient,
  workflowIds: string[],
  sinceDate: string,
): Promise<PresenceRow[]> {
  const rows = await fetchAllPaged<Record<string, unknown>>(
    (from, to) =>
      supabase
        .from('field_presence_daily')
        .select('workflow_id, field_path, day, ran_count, present_count')
        .in('workflow_id', workflowIds)
        .gte('day', sinceDate)
        .eq('is_test', false)
        .order('workflow_id', { ascending: true })
        .order('field_path', { ascending: true })
        .order('day', { ascending: true })
        .range(from, to),
    'field_presence_daily',
  )
  return rows.map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
    day: r.day as string,
    ran_count: count(r.ran_count, 'ran_count', r),
    present_count: count(r.present_count, 'present_count', r),
  }))
}

/**
 * A rollup count, or a refusal (L50).
 *
 * PostgREST renders a bigint as a string, so `Number()` is the right parse, but
 * it also renders anything it cannot render as null and turns a surprise into
 * NaN. Every threshold in this file is a `>=` or a rate, and NaN compares false
 * against all of them, so an unparsed count would drop its field out of its own
 * baseline in silence and land on the do-not-page side: the detector would go
 * on reporting an all-clear about a field it never actually measured.
 */
function count(value: unknown, column: string, row: Record<string, unknown>): number {
  // null, undefined and '' all pass through Number() as 0, which is finite and
  // means "the producing node never ran here". So a NaN check alone would let a
  // missing count read as a real measurement of zero, which is the quieter half
  // of this bug: the field drops out of every denominator with nothing said.
  const n = value === null || value === undefined || value === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(
      `field_presence_daily.${column} did not parse as a number ` +
        `(workflow ${String(row.workflow_id)}, field ${String(row.field_path)}, day ${String(row.day)})`,
    )
  }
  return n
}

// Tier-1 (hourly). Logs intended pages; sends nothing this phase.
export async function runFieldPresenceDroughtCheck(supabase: SupabaseClient): Promise<void> {
  const workflowIds = await activeWorkflowIds(supabase)
  if (workflowIds.length === 0) return
  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(Date.now() - (MIN_BASELINE_DAYS + 8) * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const hits = findDroughts(rows, today)
  const silenced = await readSilences(supabase, workflowIds)
  const visible = excludeSilenced(hits, silenced)
  for (const h of visible) {
    console.log(JSON.stringify({ event: 'field_presence_drought', ...h }))
  }
  console.log(`[field-presence-drought] checked=${workflowIds.length} workflows hits=${visible.length}`)
}

// Tier-2 (daily). Logs the day-one-dead digest as one event; sends nothing.
export async function runFieldPresenceDeadCheck(supabase: SupabaseClient): Promise<void> {
  const workflowIds = await activeWorkflowIds(supabase)
  if (workflowIds.length === 0) return
  const since = new Date(Date.now() - DEAD_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const hits = findDayOneDead(rows)
  const silenced = await readSilences(supabase, workflowIds)
  const visible = excludeSilenced(hits, silenced)
  console.log(JSON.stringify({ event: 'field_presence_dead_digest', count: visible.length, fields: visible }))
}
