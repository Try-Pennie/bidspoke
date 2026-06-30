// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import type { SupabaseClient } from '@supabase/supabase-js'
import { MIN_BASELINE_DAYS } from './volume-anomaly'

export { MIN_BASELINE_DAYS }
export const BASELINE_MIN_DAY_RUNS = 10
export const STABLE_MEAN_MIN = 0.98
export const STABLE_STDDEV_MAX = 0.02
export const COLLAPSE_K = 4
export const COLLAPSE_FLOOR = 0.10
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
  const margin = Math.max(COLLAPSE_K * sd, COLLAPSE_FLOOR)
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
): boolean {
  if (windowRan < DEAD_MIN_RUNS) return false
  if (everHealthy) return false
  return dailyRate(windowRan, windowPresent) <= DEAD_MAX_RATE
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

async function readPresenceRows(
  supabase: SupabaseClient,
  workflowIds: string[],
  sinceDate: string,
): Promise<PresenceRow[]> {
  const PAGE = 1000
  const out: PresenceRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('field_presence_daily')
      .select('workflow_id, field_path, day, ran_count, present_count')
      .in('workflow_id', workflowIds)
      .gte('day', sinceDate)
      .eq('is_test', false)
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[field-presence] field_presence_daily read failed:', error)
      break
    }
    const rows = data ?? []
    for (const r of rows) {
      out.push({
        workflow_id: r.workflow_id as string,
        field_path: r.field_path as string,
        day: r.day as string,
        ran_count: Number(r.ran_count),
        present_count: Number(r.present_count),
      })
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
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
