// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import type { SupabaseClient } from '@supabase/supabase-js'
import { MIN_BASELINE_DAYS } from './volume-anomaly'
import { fetchAllPaged } from './paginate'
import { getSlackConnection, postMessage, sendGroupedRecoveryAlert } from './slack'
import { listWithOverflow, MAX_LISTED_LINES } from './list-overflow'
import { recoveryDue, settleRecovery, markAlerted, markSpikeSeen, type RecoveryDue, type RecoveryKv } from './alert-recovery'
import { deriveWatchedFields } from '../engine/watched-fields'
import type { WorkflowDefinition } from '../types'

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
/**
 * The collapse floor for a TRAILING WINDOW rate, as against COLLAPSE_FLOOR
 * which judges a whole day (#1101).
 *
 * The two exist side by side because the same field's rate is a much noisier
 * quantity over an hour than over a day, so a floor calibrated on days is the
 * wrong floor for a window. Measured 2026-09-02 over 12,292 hour buckets across
 * 162 stable fields (6 days of `workflow_executions.field_presence`):
 *
 *   floor 0.10 (the daily one)  -> 103 buckets qualify, about 17 pages a day
 *   floor 0.25                  ->   5 buckets qualify, every one a real incident
 *
 * The distribution has an empty band that makes 0.25 a measured choice rather
 * than a taste: the 1st percentile of hourly rates is 0.9048 and the 0.1st is
 * 0.7932, so normal variation stops just above 0.75, while nothing at all in the
 * six days fell below 0.50. The three incidents it does catch sit at 0.665,
 * 0.726 and 0.356 (the last being the 2026-09-02 Main Flow outage this came
 * from). Re-measure with `npx tsx scripts/diagnose-field-presence.ts` rather
 * than trusting this comment.
 *
 * DELIBERATE BLIND SPOT: a field seeing fewer than MIN_WINDOW_SAMPLE runs an
 * hour can never be judged on a one hour window, so a total collapse on a quiet
 * workflow is still only caught by the daily surfaces. The fast path for that is
 * the per-minute upstream outage check, not this one.
 */
export const WINDOW_COLLAPSE_FLOOR = 0.25
export const MIN_WINDOW_SAMPLE = 20
/**
 * The trailing window the Tier-1 alert judges, in minutes.
 *
 * One hour, matching the hourly cron that runs the check, so consecutive runs
 * neither overlap nor leave a gap. Detection speed is therefore unchanged by
 * #1101: what changes is that the verdict is about a period the check actually
 * measured, and that a burst can no longer dilute itself out of the reading. The
 * fast path for a total outage is the per-minute upstream outage check.
 */
export const DROUGHT_WINDOW_MINUTES = 60
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
/**
 * Distinct days of rollup history a field needs before it can be called dead.
 *
 * The dead check reads a 7-day window, but the data only covers as long as the
 * field has been WATCHED, and a field enters the watched set the moment
 * something starts referencing it. On a workflow running 500,000 executions a
 * week a brand new field clears the 200-run floor within hours, so without this
 * it would be judged on a few hours of its first day, and "never resolved over 7
 * days" would be a claim the data does not support (L98, L11).
 *
 * Not hypothetical: #435 resolved code-node aliases and added 108 fields to the
 * watched set in one deploy, every one of them with no history at all. The same
 * happens on a smaller scale whenever an author edits a workflow to read a field
 * it did not read before.
 */
export const DEAD_MIN_DAYS = 3

/**
 * Runs a single day needs before its resolutions (or lack of them) can settle
 * whether a field has recovered (#1336).
 *
 * The dead verdict is one sum over DEAD_WINDOW_DAYS, so it cannot clear until
 * the zeros age out: measured 2026-09-13, Main Flow's
 * `pennie_or_eligibility.eligibility` went dead for five days when FFN's
 * firewall blocked the Worker's egress, Eligibility Scout came back on 09-10,
 * and the field resolved on the 10th, 11th, 12th and 13th while the alert went
 * on paging every morning because the window still totalled to a dead rate. It
 * would have paged eight mornings about a condition that ended on the fourth.
 *
 * The floor exists so a PARTIAL day cannot decide it in either direction. The
 * check runs at 13:00 UTC, so the newest row is always a part-day: a handful of
 * runs carrying one stray hit must not stand down a live outage, and a handful
 * carrying none is not evidence of death either. 200 is DEAD_MIN_RUNS, the same
 * traffic the window as a whole needs before it may be judged at all, so one
 * number governs "enough runs to say anything" everywhere in this tier.
 */
export const RECOVERY_MIN_DAY_RUNS = DEAD_MIN_RUNS

/**
 * How many of the most recent judgeable days a resolution may fall in.
 *
 * TWO, because the newest row is always a PART day and a part day can be
 * genuinely alive while showing nothing yet. The check runs at 13:00 UTC:
 * measured over the week to 2026-09-13, this field resolved after 13:00 on
 * 2026-09-10, so at check time that day read as zero while the field had in
 * fact recovered. Reading only the newest day pages on a morning like that, and
 * one morning in four in that sample had no hit yet by 13:00.
 *
 * Not three or more. The cost of each extra day is a day of delay in FINDING a
 * field that has just died, since yesterday's hits keep answering for today.
 * Two buys the part day its complete predecessor and nothing else.
 */
export const RECOVERY_LOOKBACK_DAYS = 2

/**
 * How the dead tier names itself, in the alert and in its own all-clear.
 *
 * One constant because the recovery notice repeats the signal name back to the
 * reader: left as "output field never resolves" it would restate, inside the
 * all-clear, the exact claim the alert stopped making in #1336.
 */
export const DEAD_SIGNAL = 'output field not resolving'

/**
 * What the dead tier's all-clear says the field is doing again.
 *
 * Not "back within normal range", which is the shared default: a single
 * resolution stands the incident down and does not put the seven day rate back
 * over the line, so the default would claim more than this check measured (L11).
 */
export const DEAD_RECOVERED_PHRASE = 'is carrying values again'

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
  minWindowSample?: number
  deadMinRuns?: number
  deadMaxRate?: number
  deadMinDays?: number
  recoveryMinDayRuns?: number
}

interface ResolvedThresholds {
  minBaselineDays: number
  stableMeanMin: number
  stableStddevMax: number
  collapseK: number
  collapseFloor: number
  minWindowSample: number
  deadMinRuns: number
  deadMaxRate: number
  deadMinDays: number
  recoveryMinDayRuns: number
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
    minWindowSample: t.minWindowSample ?? MIN_WINDOW_SAMPLE,
    deadMinRuns: t.deadMinRuns ?? DEAD_MIN_RUNS,
    deadMaxRate: t.deadMaxRate ?? DEAD_MAX_RATE,
    deadMinDays: t.deadMinDays ?? DEAD_MIN_DAYS,
    recoveryMinDayRuns: t.recoveryMinDayRuns ?? RECOVERY_MIN_DAY_RUNS,
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
  if (todayRan < t.minWindowSample) return null
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

/**
 * Whether a field is carrying values again NOW, which the window total cannot
 * see for up to DEAD_WINDOW_DAYS after the upstream comes back (#1336).
 *
 * Read as THE MOST RECENT judgeable day, never "any day in the window". The
 * difference is the whole check: on 2026-09-09, five days into the Scout
 * outage, the window still held the 4 hits of 09-03 and the 1 of 09-04, so an
 * "any day" reading would have called the field healthy throughout the outage
 * and it would never have paged at all.
 *
 * One resolution on that day is enough, which is Dan's call of 2026-09-13 taken
 * with the measurement in front of him: over 36 judgeable days this field had
 * six days with no resolution, five of them the outage itself, so a healthy day
 * essentially always resolves at least once. It is a weaker re-arm than L160
 * asks for, and what pays for that is the daily cadence: if the field is dead
 * again tomorrow, tomorrow has no resolution and the check pages the next
 * morning. The cost of clearing early is one alert cycle, not a missed outage.
 *
 * Days are aggregated before being read, because the rollup can hold more than
 * one row for a day and two rows are still one day of evidence.
 */
export function hasRecentResolution(
  rows: PresenceRow[],
  thresholds?: PresenceThresholds,
): boolean {
  const t = resolve(thresholds)
  const byDay = new Map<string, { ran: number; present: number }>()
  for (const r of rows) {
    const acc = byDay.get(r.day) ?? { ran: 0, present: 0 }
    acc.ran += r.ran_count
    acc.present += r.present_count
    byDay.set(r.day, acc)
  }
  const judgeable = [...byDay.entries()]
    .filter(([, acc]) => acc.ran >= t.recoveryMinDayRuns)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, RECOVERY_LOOKBACK_DAYS)
  // No day carried enough traffic to say anything. Not established, so the
  // field keeps whatever verdict the window gave it: an unjudgeable day must
  // never be the thing that stands an alert down (L98).
  if (judgeable.length === 0) return false
  return judgeable.some(([, acc]) => acc.present > 0)
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
  /** The observed rate over `window_minutes`, not over the calendar day. */
  window_rate: number
  window_ran: number
  /**
   * How long a period the observed rate covers, so every message built from this
   * hit states the window it actually measured instead of one inferred from the
   * check's tick (#1101, L11). 1440 for the daily-rollup surfaces.
   */
  window_minutes: number
}

/** Per-field counts over a trailing window, from the `field_presence_window` RPC. */
export interface RecentPresence {
  workflow_id: string
  field_path: string
  ran_count: number
  present_count: number
}

/** Minutes in the daily-rollup window, for the surfaces still judging a day. */
export const DAY_WINDOW_MINUTES = 1440

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
        window_rate: result.todayRate,
        window_ran: todayRow.ran_count,
        window_minutes: DAY_WINDOW_MINUTES,
      })
    }
  }
  return hits
}

// Tier-2: per field, sum the window and check day-one-dead. A field is counted
// as "ever healthy" only on a day with enough runs to trust its rate.
export function findDayOneDead(rows: PresenceRow[], thresholds?: PresenceThresholds): DeadHit[] {
  const t = resolve(thresholds)
  const hits: DeadHit[] = []
  for (const bucket of groupByField(rows).values()) {
    // Distinct days, not rows: two rows for one day is one day of evidence.
    if (new Set(bucket.map((r) => r.day)).size < t.deadMinDays) continue
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
    // Both call sites consult ONE predicate (#1336). The manifest this feeds and
    // the alert classifyDead feeds have to answer the same question, or the API
    // reports a field as dead while Slack has already stood it down.
    if (
      detectDayOneDead(windowRan, windowPresent, everHealthy, thresholds) &&
      !hasRecentResolution(bucket, thresholds)
    ) {
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

/**
 * What this run could actually establish about one field (#423).
 *
 * A live alert needs three answers, not two. "No hit" is not "healthy": Tier-1
 * judges TODAY's cumulative rate and today resets at UTC midnight, so at 00:30 a
 * field that is still completely dead has too few runs to judge and produces no
 * hit. Collapsing that into "healthy" would fire an all-clear over an ongoing
 * outage every night (L98, L11). Tier-2 has the same shape below its run floor.
 *
 * So `insufficient` means this run could not tell, and nothing is said either
 * way. Only `healthy` is evidence the condition ended, and only that announces
 * a recovery.
 */
export type FieldVerdict = 'alerting' | 'healthy' | 'insufficient'

export interface FieldState {
  workflow_id: string
  field_path: string
  verdict: FieldVerdict
  /** Present only on `alerting`, carrying what the page needs to say. */
  drought?: DroughtHit
  dead?: DeadHit
}

/**
 * Tier-1, as a verdict per field rather than only the hits.
 *
 * The two sides come from different places on purpose (#1101). The BASELINE is
 * the daily rollup, because "this field is normally always present" is a claim
 * about days and needs a week of them. The OBSERVED side is a trailing window,
 * because a burst inside one hour is exactly what the old day-to-date rate could
 * not see: it healed itself as the denominator grew, so the same failure cleared
 * with nothing fixed and could not fire at all later in a busy day.
 *
 * `baselineRows` may still contain today's partial row; it is excluded from the
 * baseline by date, so a collapsing day cannot drag its own baseline down to
 * meet it.
 *
 * The floor defaults to WINDOW_COLLAPSE_FLOOR rather than COLLAPSE_FLOOR, since
 * the quantity being judged is now a window rate. See that constant for the
 * measurement.
 */
export function classifyDrought(
  baselineRows: PresenceRow[],
  recent: RecentPresence[],
  windowMinutes: number,
  thresholds?: PresenceThresholds,
): FieldState[] {
  const withWindowFloor: PresenceThresholds = {
    collapseFloor: WINDOW_COLLAPSE_FLOOR,
    ...thresholds,
  }
  const t = resolve(withWindowFloor)
  const recentByField = new Map(recent.map((r) => [`${r.workflow_id} ${r.field_path}`, r]))
  const out: FieldState[] = []
  // Every field with a baseline gets a verdict, including the ones with no
  // traffic in the window: silence there means "could not tell", and it has to
  // be said rather than left out, or a caller reading the absence of a verdict
  // as health would announce an all-clear over an ongoing outage (L98).
  for (const bucket of groupByField(baselineRows).values()) {
    const base = { workflow_id: bucket[0].workflow_id, field_path: bucket[0].field_path }
    const today = todayKey(bucket)
    const observed = recentByField.get(`${base.workflow_id} ${base.field_path}`)
    // No traffic in the window at all, or not enough of it to judge a rate.
    if (!observed || observed.ran_count < t.minWindowSample) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    const baselineRates = bucket
      .filter((r) => r.day < today && r.ran_count >= BASELINE_MIN_DAY_RUNS)
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-7)
      .map((r) => dailyRate(r.ran_count, r.present_count))
    // A field outside the stability gate can never page, so it must never
    // announce a recovery either: there was no incident to end.
    if (!isStableBaseline(baselineRates, withWindowFloor)) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    const windowRate = dailyRate(observed.ran_count, observed.present_count)
    const hit = detectDrought(baselineRates, windowRate, observed.ran_count, withWindowFloor)
    if (hit) {
      out.push({
        ...base,
        verdict: 'alerting',
        drought: {
          ...base,
          mean: hit.mean,
          stddev: hit.stddev,
          window_rate: hit.todayRate,
          window_ran: observed.ran_count,
          window_minutes: windowMinutes,
        },
      })
    } else {
      out.push({ ...base, verdict: 'healthy' })
    }
  }
  return out
}

/**
 * The most recent day present in a field's baseline rows.
 *
 * The baseline must exclude the day still in progress, and the caller no longer
 * passes a date, so it is derived from the rows themselves. Taking the maximum
 * rather than a clock reading keeps the function pure and keeps the exclusion
 * correct when the rollup lags, since what matters is which day's row could
 * still be partial.
 */
function todayKey(bucket: PresenceRow[]): string {
  let max = ''
  for (const r of bucket) if (r.day > max) max = r.day
  return max
}

/** Tier-2, as a verdict per field rather than only the hits. */
export function classifyDead(
  rows: PresenceRow[],
  thresholds?: PresenceThresholds,
): FieldState[] {
  const t = resolve(thresholds)
  const out: FieldState[] = []
  for (const bucket of groupByField(rows).values()) {
    const base = { workflow_id: bucket[0].workflow_id, field_path: bucket[0].field_path }
    let windowRan = 0
    let windowPresent = 0
    let everHealthy = false
    for (const r of bucket) {
      windowRan += r.ran_count
      windowPresent += r.present_count
      if (r.ran_count >= BASELINE_MIN_DAY_RUNS && dailyRate(r.ran_count, r.present_count) >= t.stableMeanMin) {
        everHealthy = true
      }
    }
    // Too little traffic over the window to call a field dead. This is the
    // population the design knowingly accepts a detection delay on, and it is
    // reported as unjudged rather than as fine.
    if (windowRan < t.deadMinRuns || new Set(bucket.map((r) => r.day)).size < t.deadMinDays) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    if (
      detectDayOneDead(windowRan, windowPresent, everHealthy, thresholds) &&
      !hasRecentResolution(bucket, thresholds)
    ) {
      out.push({
        ...base,
        verdict: 'alerting',
        dead: { ...base, window_ran: windowRan, window_present: windowPresent },
      })
    } else {
      out.push({ ...base, verdict: 'healthy' })
    }
  }
  return out
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

/**
 * How long a paged (workflow, field) stays deduped.
 *
 * Deliberately longer than the 30 minutes the minute-cadence alerts use. A field
 * drought is a day-scale condition judged against today's cumulative rate, so it
 * persists for the rest of the day once it starts; at the hourly cadence a 30
 * minute cooldown would suppress nothing and page every hour about the same
 * field. Twelve hours caps it at two pages a day per field, and the recovery
 * all-clear clears the key early when the field genuinely comes back.
 */
export const FIELD_COOLDOWN_TTL_SECONDS = 12 * 60 * 60

export interface ActiveWorkflow {
  id: string
  name: string
  organization_id: string
  slack_channel: string | null
  /**
   * The live definition, used to answer whether anything STILL reads a field.
   * Null when the row carried none, which means "cannot tell" rather than
   * "reads nothing": see `watchedNow` (#1119).
   */
  definition: WorkflowDefinition | null
}

/**
 * What each workflow reads RIGHT NOW, or null when that cannot be determined.
 *
 * The detector otherwise judges purely from seven days of history, so removing a
 * reference did not stop its alert: the rows already written kept firing it
 * until they aged out of the window (#1119). That punishes the correct response
 * to the alert and leaves "silence it with a reason" as the only way to stop it.
 *
 * Derived with `deriveWatchedFields`, the SAME function the capture uses to
 * decide what to record, so the reader and the writer cannot disagree about what
 * is watched (L70). A node the derivation bails open on contributes nothing here
 * AND records nothing there, so the two stay consistent by construction.
 *
 * A workflow with no readable definition yields null and is NOT filtered. An
 * absent definition must not read as "reads nothing", which would silence every
 * field on that workflow at once and look exactly like a healthy sweep (L98).
 */
function watchedNow(workflows: ActiveWorkflow[]): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>()
  for (const wf of workflows) {
    if (!wf.definition || !Array.isArray(wf.definition.nodes)) {
      out.set(wf.id, null)
      continue
    }
    try {
      out.set(wf.id, new Set(deriveWatchedFields(wf.definition)))
    } catch (err) {
      // A definition this cannot parse is unknown, never empty.
      console.error(`[field-presence] watched-set derivation failed for ${wf.id}:`, err)
      out.set(wf.id, null)
    }
  }
  return out
}

/**
 * The active, non-deleted workflows.
 *
 * THROWS on a read failure rather than returning what it has. An empty list
 * makes both checks a silent no-op that looks exactly like a healthy sweep, and
 * that is the shape where the system goes quietest precisely when it can see
 * least (L98). The cron site logs the throw and the daily heartbeat reports the
 * absence of a run.
 */
async function activeWorkflows(supabase: SupabaseClient): Promise<ActiveWorkflow[]> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, organization_id, slack_channel, definition')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (error) throw new Error(`workflows read failed: ${error.message}`)
  return (data ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    organization_id: w.organization_id as string,
    slack_channel: (w.slack_channel as string | null) ?? null,
    definition: (w.definition as WorkflowDefinition | null) ?? null,
  }))
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
 * Per-field counts over the trailing window, via the `field_presence_window` RPC
 * (#1101).
 *
 * THROWS on a read failure, exactly like readPresenceRows and for the same
 * reason: a detector judging a window from rows it never saw would call a
 * healthy field collapsed, and an empty answer is indistinguishable from a field
 * with no traffic (L215, L211). The caller logs and skips the cycle.
 */
async function readPresenceWindow(
  supabase: SupabaseClient,
  workflowIds: string[],
  windowMinutes: number,
): Promise<RecentPresence[]> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  const { data, error } = await supabase.rpc('field_presence_window', {
    p_workflow_ids: workflowIds,
    p_since: since,
  })
  if (error) {
    throw new Error(`field_presence_window read failed: ${error.message}`)
  }
  const rows = (data ?? []) as Record<string, unknown>[]
  return rows.map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
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

/**
 * The measured window in words, for a message a person reads.
 *
 * Exists so the alert and the recovery notice cannot describe the same window
 * two different ways.
 */
export function describeWindow(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? 'day' : `${days} days`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? 'hour' : `${hours} hours`
  }
  return `${minutes} minutes`
}

/**
 * The Slack message for a field that stopped carrying a value.
 *
 * Says the four things an operator needs before they can act: which workflow,
 * which field, what changed (its own baseline against the measured window), and
 * where to look. Returns the message ts, or null when it did not deliver, so the
 * caller can gate the cooldown on delivery rather than on the attempt.
 *
 * The window is named explicitly rather than called "today" (#1101). It used to
 * report a day-to-date rate while the check ran hourly, which made the reader
 * infer a period nobody had measured.
 */
export async function sendFieldDroughtAlert(
  slack: { bot_token: string },
  channel: string,
  fields: GroupedField[],
  appUrl: string,
): Promise<string | null> {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines = fields.map((f) => {
    const hit = f.state.drought as DroughtHit
    return (
      `*${f.workflowName}* \`${hit.field_path}\` normally carries a value on *${pct(hit.mean)}* ` +
      `of runs, and carried one on *${pct(hit.window_rate)}* of ${hit.window_ran} runs over the ` +
      `last ${describeWindow(hit.window_minutes)}  <${appUrl}/workflows/${f.workflowId}|open>`
    )
  })
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: fields.length === 1 ? 'Output Field Stopped' : 'Output Fields Stopped',
        emoji: false,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: listWithOverflow(lines, fields.length, MAX_LISTED_LINES) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Something downstream reads this, so those runs are proceeding without it. ' +
          'The usual causes are an upstream API returning a different shape, or a code node ' +
          'swallowing an error into an empty result.',
      },
    },
  ]
  const summary =
    fields.length === 1
      ? `Output field stopped: ${fields[0].workflowName} ${fields[0].state.field_path}`
      : `${fields.length} output fields stopped`
  return postMessage(slack.bot_token, channel, blocks, summary)
}


/** One entry in a grouped alert: which workflow, and the verdict for one field. */
export interface GroupedField {
  workflowName: string
  workflowId: string
  state: FieldState
}

/**
 * The Slack message for fields that have never carried a value.
 *
 * Worded differently from the drought on purpose. A drought is "this broke
 * today"; this is "this has never worked", which usually means the reference
 * itself is wrong rather than the upstream being down, and the fix is usually to
 * correct or delete the reference (L11).
 *
 * ONE message for the whole batch (#1120). On 2026-09-03 this posted seven
 * separate messages in a row, each repeating the same three paragraphs of
 * advice, and the two findings that mattered were indistinguishable from the
 * five that did not. The advice is said once, at the end, rather than per field.
 */
export async function sendFieldDeadAlert(
  slack: { bot_token: string },
  channel: string,
  fields: GroupedField[],
  appUrl: string,
): Promise<string | null> {
  const lines = fields.map((f) => {
    const hit = f.state.dead as DeadHit
    return (
      `*${f.workflowName}* \`${hit.field_path}\` carried a value on ` +
      `*${hit.window_present} of ${hit.window_ran}* runs  <${appUrl}/workflows/${f.workflowId}|open>`
    )
  })
  // Say only what the check measured (L11, #1336). The old wording claimed the
  // fields had "never carried a value" directly above lines reporting the runs
  // on which they had, because the rate ceiling is deliberately just above zero
  // rather than at it. Both halves came from here, so both are fixed here.
  const ceiling = `${DEAD_MAX_RATE * 100}%`
  const what =
    `resolved on at most ${ceiling} of runs over the last ${DEAD_WINDOW_DAYS} days, ` +
    'and not at all on the most recent day.'
  const heading =
    fields.length === 1
      ? `One field is read but has all but stopped resolving. It ${what}`
      : `${fields.length} fields are read but have all but stopped resolving. Each ${what}`
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: fields.length === 1 ? 'Output Field Not Resolving' : 'Output Fields Not Resolving',
        emoji: false,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: listWithOverflow(lines, fields.length, MAX_LISTED_LINES) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'This usually means the reference path is wrong or has gone obsolete, rather than ' +
          'an upstream being down. Either correct the path or remove the reference. If an ' +
          'upstream was down, no action is needed: this stands down by itself on the first day ' +
          'the field resolves again.',
      },
    },
  ]
  const summary =
    fields.length === 1
      ? `Output field not resolving: ${fields[0].workflowName} ${fields[0].state.field_path}`
      : `${fields.length} output fields not resolving`
  return postMessage(slack.bot_token, channel, blocks, summary)
}

/** `${workflow_id} ${field_path}`, the key both the silences and the KV use. */
function fieldKey(workflowId: string, fieldPath: string): string {
  return `${workflowId} ${fieldPath}`
}

interface TierConfig {
  /** KV/recovery prefix, so the two tiers never share an incident marker (L53). */
  prefix: string
  signal: string
  /**
   * The window this tier judges, in minutes, so its all-clear reports what was
   * measured rather than the gap between the check's own ticks (#1101).
   * Required, not optional: a tier that forgot it would silently go back to
   * reporting a duration nobody observed, and the compiler is the only thing
   * that can notice a missing field on a new tier.
   */
  measuredWindowMinutes: number
  /**
   * What this tier's all-clear says the subject is doing again, when the shared
   * "back within normal range" would overclaim (#1336). Optional: a tier that
   * omits it keeps the default.
   */
  recoveredPhrase?: string
  /** Sends ONE message covering every field in a channel's group (#1120). */
  send: (
    slack: { bot_token: string },
    channel: string,
    fields: GroupedField[],
    appUrl: string,
  ) => Promise<string | null>
}

/**
 * Page, dedupe and stand down over a set of per-field verdicts.
 *
 * Shared by both tiers because they differ only in how the verdict was reached
 * and what the message says; the alerting rules (org gate, per-field cooldown,
 * cooldown only on delivery, all-clear when the field genuinely recovers) are
 * one implementation rather than a copy each.
 *
 * `insufficient` deliberately does nothing at all: it neither pages nor stands
 * down, because this run could not tell.
 */
/** A field that has passed every gate and is waiting to be put in a group. */
interface Pageable {
  wf: ActiveWorkflow
  state: FieldState
  id: string
  cooldownKey: string
}

/** What `getSlackConnection` yields, kept local so the group map can be typed. */
type SlackConnection = { bot_token: string; default_channel: string; volume_alerts_enabled: boolean }

async function alertOnStates(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
  workflows: ActiveWorkflow[],
  states: FieldState[],
  silenced: Set<string>,
  cfg: TierConfig,
): Promise<{ paged: number; recovered: number; unwatchable: number }> {
  const byId = new Map(workflows.map((w) => [w.id, w]))
  const watched = watchedNow(workflows)
  // Counted, not only logged per workflow (L77). Falling back to "do not filter"
  // is the safe direction, but it is also indistinguishable from a healthy run,
  // so if every definition stopped parsing the #1119 filter would switch itself
  // off in silence. The run's own summary line carries the number.
  const unwatchable = [...watched.values()].filter((set) => set === null).length
  const pageable: Pageable[] = []
  const recoverable: (Pageable & { due: RecoveryDue })[] = []
  let paged = 0
  let recovered = 0

  for (const state of states) {
    if (state.verdict === 'insufficient') continue
    const wf = byId.get(state.workflow_id)
    if (!wf) continue
    const id = fieldKey(state.workflow_id, state.field_path)
    const cooldownKey = `${cfg.prefix}-cooldown:${id}`

    // A silenced field is one the author has said may be empty. It must not
    // page, and it must not announce a recovery either: there is no incident.
    if (silenced.has(id)) continue

    // A field nothing reads any more is not a field that never resolves, it is
    // a field that no longer exists, so it neither pages nor stands down for the
    // same reason (#1119). Only filtered when the watched set is KNOWN: null
    // means the definition could not be read, and treating that as "reads
    // nothing" would silence the whole workflow.
    const stillWatched = watched.get(state.workflow_id)
    if (stillWatched && !stillWatched.has(state.field_path)) continue

    if (state.verdict === 'healthy') {
      // Decided per field, announced per channel below (#1267): the page is one
      // message per channel, and its all-clear has to be the same shape.
      const due = await recoveryDue(kv, cfg.prefix, id)
      if (due) recoverable.push({ wf, state, id, cooldownKey, due })
      continue
    }

    // Stamp the incident's running end on EVERY alerting tick, before the
    // cooldown gate, so the all-clear reports how long the field was empty
    // rather than how long ago we last mentioned it.
    await markSpikeSeen(kv, cfg.prefix, id)
    if (await kv.get(cooldownKey)) continue

    pageable.push({ wf, state, id, cooldownKey })
  }

  // One message per channel rather than one per field (#1120). Every gate above
  // still runs per field, so a silenced, cooled-down or no-longer-read field is
  // absent from the group entirely rather than listed and then suppressed.
  const connections = new Map<string, SlackConnection | null>()
  async function byChannel<T extends Pageable>(items: T[]) {
    const groups = new Map<string, { slack: SlackConnection; channel: string; items: T[] }>()
    for (const item of items) {
      const org = item.wf.organization_id
      if (!connections.has(org)) connections.set(org, await getSlackConnection(supabase, org))
      const slack = connections.get(org) ?? null
      if (!slack || !slack.volume_alerts_enabled) {
        console.log(`[${cfg.prefix}] no Slack or opted-out org=${org} field=${item.id}`)
        continue
      }
      const channel = item.wf.slack_channel ?? slack.default_channel
      const key = `${org}:${channel}`
      const group = groups.get(key)
      if (group) group.items.push(item)
      else groups.set(key, { slack, channel, items: [item] })
    }
    return groups.values()
  }

  for (const group of await byChannel(pageable)) {
    const fields: GroupedField[] = group.items.map((i) => ({
      workflowName: i.wf.name,
      workflowId: i.wf.id,
      state: i.state,
    }))
    const sent = await cfg.send(group.slack, group.channel, fields, appUrl)
    // Only start the cooldowns once the alert actually delivered: a kicked bot
    // must not suppress the retry for 12 hours while the fields stay empty. It
    // is all or nothing per group, because one message covers all of them.
    if (!sent) continue
    for (const item of group.items) {
      await kv.put(item.cooldownKey, '1', { expirationTtl: FIELD_COOLDOWN_TTL_SECONDS })
      await markAlerted(kv, cfg.prefix, item.id)
      paged++
    }
  }

  // The all-clear, grouped the same way (#1267). Settled all or nothing per
  // group for the same reason the cooldowns are: one message covers them all,
  // so a failed send leaves every incident in it open for the next tick.
  for (const group of await byChannel(recoverable)) {
    const sent = await sendGroupedRecoveryAlert(group.slack, group.channel, {
      signal: cfg.signal,
      recoveredPhrase: cfg.recoveredPhrase,
      // Declared so the all-clear cannot report the gap between hourly ticks as
      // the length of the incident (#1101). Tier-2 judges whole days and passes
      // its own window for the same reason.
      measuredWindowMinutes: cfg.measuredWindowMinutes,
      items: group.items.map((i) => ({
        subject: `${i.wf.name} ${i.state.field_path}`,
        alertedAt: i.due.alertedAt,
        endedAt: i.due.endedAt,
        url: `${appUrl}/workflows/${i.wf.id}`,
      })),
    })
    if (!sent) continue
    for (const item of group.items) {
      await settleRecovery(kv, cfg.prefix, item.id, item.cooldownKey)
      recovered++
    }
  }
  return { paged, recovered, unwatchable }
}

/**
 * Tier-1 (hourly): a field that normally carries a value has stopped.
 *
 * Live since #423. Thresholds were calibrated against 24 days of the dark run
 * (#432), which produced zero Tier-1 hits, so a page here is not a routine
 * event.
 */
export async function runFieldPresenceDroughtCheck(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
): Promise<void> {
  const workflows = await activeWorkflows(supabase)
  if (workflows.length === 0) return
  const workflowIds = workflows.map((w) => w.id)
  const since = new Date(Date.now() - (MIN_BASELINE_DAYS + 8) * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const recent = await readPresenceWindow(supabase, workflowIds, DROUGHT_WINDOW_MINUTES)
  const states = classifyDrought(rows, recent, DROUGHT_WINDOW_MINUTES)
  const silenced = await readSilences(supabase, workflowIds)

  for (const s of states) {
    if (s.verdict === 'alerting' && !silenced.has(fieldKey(s.workflow_id, s.field_path))) {
      console.log(JSON.stringify({ event: 'field_presence_drought', ...s.drought }))
    }
  }
  const { paged, recovered, unwatchable } = await alertOnStates(supabase, kv, appUrl, workflows, states, silenced, {
    prefix: 'field-presence-drought',
    signal: 'output field stopped',
    measuredWindowMinutes: DROUGHT_WINDOW_MINUTES,
    send: (slack, channel, fields, url) => sendFieldDroughtAlert(slack, channel, fields, url),
  })
  console.log(
    `[field-presence-drought] workflows=${workflows.length} ` +
      `alerting=${states.filter((s) => s.verdict === 'alerting').length} ` +
      `healthy=${states.filter((s) => s.verdict === 'healthy').length} ` +
      `unjudged=${states.filter((s) => s.verdict === 'insufficient').length} ` +
      `paged=${paged} recovered=${recovered} unwatchable=${unwatchable}`,
  )
}

/**
 * Tier-2 (daily): a field that has never carried a value despite many runs.
 *
 * Live since #423. On the calibrated ceiling this reports only references that
 * resolve on literally none of their runs.
 */
export async function runFieldPresenceDeadCheck(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
): Promise<void> {
  const workflows = await activeWorkflows(supabase)
  if (workflows.length === 0) return
  const workflowIds = workflows.map((w) => w.id)
  const since = new Date(Date.now() - DEAD_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const states = classifyDead(rows)
  const silenced = await readSilences(supabase, workflowIds)

  const visible = states.filter(
    (s) => s.verdict === 'alerting' && !silenced.has(fieldKey(s.workflow_id, s.field_path)),
  )
  console.log(
    JSON.stringify({
      event: 'field_presence_dead_digest',
      count: visible.length,
      fields: visible.map((s) => s.dead),
    }),
  )
  const { paged, recovered, unwatchable } = await alertOnStates(supabase, kv, appUrl, workflows, states, silenced, {
    prefix: 'field-presence-dead',
    signal: DEAD_SIGNAL,
    recoveredPhrase: DEAD_RECOVERED_PHRASE,
    measuredWindowMinutes: DEAD_WINDOW_DAYS * DAY_WINDOW_MINUTES,
    send: (slack, channel, fields, url) => sendFieldDeadAlert(slack, channel, fields, url),
  })
  console.log(
    `[field-presence-dead] workflows=${workflows.length} alerting=${visible.length} ` +
      `unjudged=${states.filter((s) => s.verdict === 'insufficient').length} ` +
      `paged=${paged} recovered=${recovered} unwatchable=${unwatchable}`,
  )
}
