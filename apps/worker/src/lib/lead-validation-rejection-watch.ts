/**
 * The per reason rejection rate watch for a lead validation swap (#2592, part
 * of #934).
 *
 * WHY. Phase 5 of #934 replaces each bidding workflow's hand written
 * `validate_bidding_and_state` code step with the lead validation node, one
 * workflow at a time, keeping the step's namespace. Three proofs run before the
 * paste, but a difference none of them reached (a lead shape no fixture held,
 * a Constants value read differently) shows up in production as a reason's
 * share of the leads moving. This check is what notices, and its page is the
 * rollback trigger written on the swap's issue.
 *
 * WHAT IT JUDGES. Every hour, each watched workflow's finished live runs in the
 * WINDOW_MINUTES ending SETTLE_MS ago, against the same workflow's runs over the
 * BASELINE_DAYS whole days before that window (baselineDays). A run is counted by where it ENDED
 * (workflow_executions.final_node_namespace) and the reason its answer gave
 * (response_body.reason), which is the same field for the script and the node:
 * the money gate's A/B mode found the two answers identical (#2623), so the
 * baseline week of script runs and the hours of node runs are read the same way.
 * The buckets are each reason on the shared list (LEAD_REJECTION_REASONS), a
 * reason not on it, a run that failed at the step, and all rejections together.
 * The denominator is every finished live run of the workflow: about 4 in 20,835
 * of GigFi's runs did not reach the step in the week measured.
 *
 * THE RULE, set from GigFi's real traffic (2026-10-14 13:00 to 2026-10-21 21:00
 * UTC, 20,835 runs, its whole workflow_executions retention). GigFi gets leads
 * only from about 13:00 to 23:00 UTC, 200 to 500 an hour. Over every two hour
 * window of that week (68 windows of 416 to 983 runs):
 *  - ineligible state ran 8.1% to 14.4% of a window against 11.4% for the week
 *    (0.71 to 1.26 times), loan amount exceeds maximum 11.8% to 26.0% against
 *    15.9% (0.74 to 1.64 times), all rejections 21.5% to 39.7% against 27.3%;
 *  - every other reason was 0, apart from 2 invalid name in the week.
 * So (REJECTION_RULE) a reason holding at least `commonShare` (2%) of the week
 * pages when its share falls to `dropRatio` (half) of the week's (a check
 * letting through what it used to reject) or rises to `riseRatio` (twice) the
 * week's (a check rejecting too much): neither was reached by any window. A
 * reason the week barely saw pages when it reaches `rareMinCount` (10) leads
 * and `rareMinPoints` (3 points) above its share, which no window came near
 * (the most was 2). A common reason's move must also be beyond chance at the
 * window's count, `maxChance` (1 in 1,000, #2851): see THE CHANCE FLOOR. A
 * window of fewer than `minRuns` (300) is not judged (the first hour of each day and every night), and a baseline of fewer than
 * `baselineMinRuns` (3,000, about a day) is unmeasured. Re-measure after a few weeks of
 * node runs (L172).
 *
 * THE CHANCE FLOOR (#2851). The ratio alone was crossed on four Lead Economy
 * mornings in the week to 2026-10-27, each ineligible state falling to about 1.3% (5 of
 * 387 on the 27th) against 2.9% for the week. Nothing had changed: its leads
 * from 8 to 11 AM Eastern are rejected for state less often (1.8%, 45 of 2,462
 * that week), and at 300 to 500 runs a window, half a 2.9% share is a drop of
 * about 11 leads to 5, a 1 in 29 chance. So a common reason pages only when its
 * count is also at most a `maxChance` chance at the baseline's share
 * (binomial-tail.ts). Every hourly two hour window of that week (counted
 * through lead_validation_rejection_counts) was replayed with it: no window of
 * GigFi (65 judged), LendSwift (167) or Lead Economy (35) paged; a common reason
 * falling to none was still paged in every window; a common reason doubling was
 * still paged in every window but 11 of Lead Economy's 35 for ineligible state,
 * the thinnest, where a doubling is about 9 more leads and is paged by the next,
 * busier window if it holds. The baseline is not matched to the window's hours:
 * the floor absorbs the morning dip at these counts, as the replay measured,
 * while Lead Economy's 8 to 10 AM hours hold under 1,000 runs a week, below
 * `baselineMinRuns`, so an hour matched baseline would leave its mornings
 * unmeasured.
 *
 * WHAT IT CANNOT SEE. A reason with no real cases (bidding not active, military
 * status ineligible and unqualified on GigFi; bidding not active, ineligible
 * state and employment status missing on LendSwift; bidding not active, invalid
 * name and missing phone on Lead Economy) can only rise: a check that stops
 * rejecting it is invisible here and was proved by the grid instead. The same
 * holds for a reason under the 2% common share, which only the rare floor
 * judges (military status ineligible on LendSwift, 0.63%). A small shift inside
 * the measured spread is not a page.
 *
 * The baseline is the BASELINE_DAYS whole days ending at the last
 * BASELINE_DAY_ENDS_UTC_HOUR (08:00 UTC) before the window, or from a watch's
 * baselineSince when that is later (REJECTION_WATCHES says why each has one),
 * and the page names the span it covered. Whole days, so each is counted once
 * and kept rather than the week being recounted every hour (#2647, see Reads).
 * The hours between the baseline's end and the window's start (1 to 24 of them) are in
 * neither, which leaves the week's shares, the figures the rule was set
 * against, as they were.
 *
 * Conventions shared with the other rate checks (partner-error-rate.ts): the
 * incident record through markAlerted, recordPageOutcome and announceRecovery under
 * the registered signal, a COOLDOWN between repeat pages, an all-clear only on a
 * judged normal window at least one whole window after the last shift, and an
 * open incident kept, never stood down, through hours with no leads. Its own
 * heartbeat (cron-heartbeat.ts) and a job_runs record, and a count it cannot
 * read throws, so a run that cannot judge is a failed run of the job rather
 * than a quiet workflow.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { announceRecovery, markAlerted, markSpikeSeen, recordPageOutcome, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { readActiveWorkflows, type ActiveWorkflowRow } from './active-workflows'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { getSlackConnection, sendLeadValidationRejectionAlert, sendRecoveryAlert } from './slack'
import { formatErr } from './format-error'
import { chanceAtLeast, chanceAtMost } from './binomial-tail'

/** The incident record's signal. */
export const LEAD_VALIDATION_REJECTION_SIGNAL = 'lead-validation-rejection-rate'
/** The heartbeat and job_runs name. */
export const LEAD_VALIDATION_REJECTION_JOB = 'lead-validation-rejection-watch'
/** The words the all-clear names the alert by, which the incident record's label repeats (L118). */
export const LEAD_VALIDATION_REJECTION_RECOVERY_WORDS = 'lead validation rejections'

export const WINDOW_MINUTES = 120
export const BASELINE_DAYS = 7
/** The judged window ends this long before the run: a run is written once it finishes, in seconds. */
export const SETTLE_MS = 2 * 60 * 1000
/** Between repeat pages for a shift that stands. The check runs hourly. */
export const COOLDOWN_TTL_SECONDS = 3 * 60 * 60

export interface RejectionRule {
  minRuns: number
  baselineMinRuns: number
  /** A reason at or above this share of the baseline is judged by ratio; below it, by the rare floor. */
  commonShare: number
  dropRatio: number
  riseRatio: number
  /** A common reason's move pages only when a count that far out has at most this chance at the window's runs (#2851). */
  maxChance: number
  rareMinCount: number
  rareMinPoints: number
}

export const REJECTION_RULE: RejectionRule = {
  minRuns: 300,
  baselineMinRuns: 3_000,
  commonShare: 0.02,
  dropRatio: 0.5,
  riseRatio: 2,
  maxChance: 0.001,
  rareMinCount: 10,
  rareMinPoints: 0.03,
}

export interface RejectionWatch {
  workflowId: string
  /** The validation step, which keeps its namespace across the swap. */
  namespace: string
  reasons: readonly string[]
  /**
   * When set, the baseline never reads runs started before this time: the save
   * of the version whose rules the baseline must hold, when the runs before it
   * were judged by different ones. Once it is more than BASELINE_DAYS back it
   * changes nothing.
   */
  baselineSince?: string
}

/**
 * Each workflow's rule is REJECTION_RULE, measured on its own traffic:
 *  - RML GigFi (#2592): see the module comment.
 *  - RML LendSwift (#2593): every two hour window of 2026-10-14 02:00 to
 *    2026-10-22 02:00 UTC (113,644 runs, 191 windows of 347 to 2,698; it gets
 *    leads around the clock). loan amount exceeds maximum ran 6.9% to 19.1% of
 *    a window against 12.3% for the week (0.56 to 1.55 times), all rejections
 *    7.5% to 19.6% against 12.9%; military status ineligible (0.63%, so judged
 *    by the rare floor) peaked at 18 in a window and invalid name at 6. No
 *    state rejection reaches the step. None would have paged.
 *  - Lead Economy (#2594): version 39, saved 2026-10-19 14:53:40 UTC, began
 *    rejecting a loan under $2,000 as unqualified_lead, which moved that reason
 *    from about none of the runs to about 30%. Against a baseline running back
 *    past that save, 24 windows since would have paged, so its baseline starts
 *    there (baselineSince). From 15:00 that day to 2026-10-22 02:00 UTC (7,884
 *    runs, 20 judged windows of 329 to 723): ineligible state 2.0% to 4.5%
 *    against 3.2% (0.63 to 1.43 times), unqualified_lead 24.6% to 36.4% against
 *    29.6% (0.83 to 1.23 times), all rejections 28.9% to 38.9% against 32.8%.
 *    None would have paged. Its leads run about 130 an hour, so many two hour
 *    windows are under minRuns and not judged.
 */
export const REJECTION_WATCHES: readonly RejectionWatch[] = [
  { workflowId: '6624acd0-bf61-4d21-85fc-4371ca7ed77d', namespace: 'validate_bidding_and_state', reasons: LEAD_REJECTION_REASONS },
  { workflowId: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914', namespace: 'validate_bidding_and_state', reasons: LEAD_REJECTION_REASONS },
  { workflowId: '89b1a6af-7e0f-43de-bc66-1e888184551f', namespace: 'validate_bidding_and_state', reasons: LEAD_REJECTION_REASONS, baselineSince: '2026-10-19T14:53:40.535Z' },
]

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** One window's runs: every finished live run, those that ended at the step, those that failed there, and the rejections by reason. */
export interface RejectionCounts {
  runs: number
  atStep: number
  failed: number
  byReason: Record<string, number>
}

export const OTHER_REASON_BUCKET = 'a reason not on the list'
export const FAILED_BUCKET = 'the step failed'
export const ALL_REJECTIONS_BUCKET = 'all rejections'

export interface BucketCount {
  bucket: string
  count: number
}

/**
 * The buckets a window is judged in: each listed reason, a reason not on the
 * list, a failed step, and all rejections. Refuses counts that cannot add up,
 * so a misread is never judged as a shift (L90).
 */
export function rejectionBuckets(c: RejectionCounts): BucketCount[] {
  const reasons = Object.entries(c.byReason)
  const listed = reasons.reduce((a, [, n]) => a + n, 0)
  const other = c.atStep - c.failed - listed
  if (c.atStep > c.runs || c.failed > c.atStep || other < 0 || reasons.some(([, n]) => n < 0)) {
    throw new Error(`rejection counts do not add up: ${c.runs} runs, ${c.atStep} at the step, ${c.failed} failed, ${listed} with a listed reason`)
  }
  return [
    ...reasons.map(([bucket, count]) => ({ bucket, count })),
    { bucket: OTHER_REASON_BUCKET, count: other },
    { bucket: FAILED_BUCKET, count: c.failed },
    { bucket: ALL_REJECTIONS_BUCKET, count: listed + other },
  ]
}

export interface RejectionShift {
  bucket: string
  direction: 'rose' | 'fell'
  count: number
  share: number
  baselineCount: number
  baselineShare: number
}

export type RejectionVerdict =
  | { state: 'unjudged'; runs: number }
  | { state: 'unmeasured'; runs: number; baselineRuns: number; reason: string }
  | { state: 'normal'; runs: number; baselineRuns: number }
  | { state: 'shifted'; runs: number; baselineRuns: number; shifts: RejectionShift[] }

/** Pure: whether a window's shares moved from the baseline's, bucket by bucket. */
export function judgeRejectionShares(current: RejectionCounts, baseline: RejectionCounts, rule: RejectionRule = REJECTION_RULE): RejectionVerdict {
  const now = rejectionBuckets(current)
  if (current.runs < rule.minRuns) return { state: 'unjudged', runs: current.runs }
  const before = new Map(rejectionBuckets(baseline).map((b) => [b.bucket, b.count]))
  if (baseline.runs < rule.baselineMinRuns) {
    return { state: 'unmeasured', runs: current.runs, baselineRuns: baseline.runs, reason: `the baseline holds ${baseline.runs} runs, under the ${rule.baselineMinRuns} it needs` }
  }
  const shifts: RejectionShift[] = []
  for (const { bucket, count } of now) {
    const baselineCount = before.get(bucket) ?? 0
    const share = count / current.runs
    const baselineShare = baselineCount / baseline.runs
    const base = { bucket, count, share, baselineCount, baselineShare }
    if (baselineShare >= rule.commonShare) {
      if (share <= baselineShare * rule.dropRatio && chanceAtMost(count, current.runs, baselineShare) <= rule.maxChance) shifts.push({ ...base, direction: 'fell' })
      else if (share >= baselineShare * rule.riseRatio && chanceAtLeast(count, current.runs, baselineShare) <= rule.maxChance) shifts.push({ ...base, direction: 'rose' })
    } else if (count >= rule.rareMinCount && share - baselineShare >= rule.rareMinPoints) {
      shifts.push({ ...base, direction: 'rose' })
    }
  }
  return shifts.length
    ? { state: 'shifted', runs: current.runs, baselineRuns: baseline.runs, shifts }
    : { state: 'normal', runs: current.runs, baselineRuns: baseline.runs }
}

// ── Reads ───────────────────────────────────────────────────────────────────
//
// THE COST (#2647). The watch first sent 3 + 9 head counts per span, each a
// separate pass over the same rows, and recounted the whole baseline week every
// hour. RML LendSwift ran 99,115 times in the week to 2026-10-22: its week is
// about 101,000 heap pages (a pass reads one per run), 790 MB of the database's
// 1 GB shared_buffers. Warm, the twelve counts took about a second; in the hours
// other heavy work had pushed those pages out (04:00, 05:00, 06:00, 09:00 and
// 14:00 UTC that day) they took 20 to 30 s and were cancelled twice at the 30 s
// service_role ceiling. Measured on 2026-10-22 at 15:30 UTC, a cold page cost
// about 0.55 ms (1,146 pages in one sample), so even ONE pass over a cold week
// would run near a minute. Two changes, then:
//  1. Every bucket of a span is counted in one pass by
//     lead_validation_rejection_counts (migration 20261022160000), grouped by
//     the answer's reason: 14,436 pages and 37 ms warm for one LendSwift day,
//     against twelve passes before.
//  2. The baseline is seven WHOLE days ending at BASELINE_DAY_ENDS_UTC_HOUR,
//     counted one day per read and kept in KV once counted, so an hourly run
//     reads only its two hour window, and one new day joins the baseline each
//     day (about 14,500 LendSwift runs, at most 8 s even if every page were
//     cold). A day is never re-read for the same watch while it is kept.

/** The function that counts a span's buckets in one pass. */
export const REJECTION_COUNTS_RPC = 'lead_validation_rejection_counts'

/**
 * The baseline's days end at this UTC hour. A new day first joins at the hourly
 * run once the window starts after it: 11:00 UTC, an hour the twelve old counts
 * ran in under 1.1 s on 2026-10-22, clear of the slow 04:00 to 06:00 and 09:00
 * hours. A failed count is retried at 12:00 and 13:00, both measured quiet too.
 */
export const BASELINE_DAY_ENDS_UTC_HOUR = 8

/** Every count a span holds, with every reason the answers gave (listed or not). */
interface SpanCounts {
  runs: number
  atStep: number
  failed: number
  byReason: Record<string, number>
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

function spanCountsOf(v: unknown): SpanCounts | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const runs = o.runs, atStep = o.atStep ?? o.at_step, failed = o.failed, byReason = o.byReason ?? o.by_reason
  if (!isCount(runs) || !isCount(atStep) || !isCount(failed) || atStep > runs || failed > atStep) return null
  if (typeof byReason !== 'object' || byReason === null || Array.isArray(byReason)) return null
  if (!Object.values(byReason).every(isCount)) return null
  return { runs, atStep, failed, byReason: { ...(byReason as Record<string, number>) } }
}

async function readSpanCounts(supabase: SupabaseClient, watch: RejectionWatch, from: Date, to: Date): Promise<SpanCounts> {
  const span = `${watch.workflowId} ${from.toISOString()} to ${to.toISOString()}`
  const answer: { data: unknown; error: unknown } = await supabase.rpc(REJECTION_COUNTS_RPC, {
    p_workflow_id: watch.workflowId,
    p_namespace: watch.namespace,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  const { data, error } = answer
  if (error) throw new Error(`${LEAD_VALIDATION_REJECTION_JOB} counts ${span}: ${formatErr(error)}`)
  const counts = Array.isArray(data) && data.length === 1 ? spanCountsOf(data[0]) : null
  if (!counts) throw new Error(`${LEAD_VALIDATION_REJECTION_JOB} counts ${span}: the answer was not one row of counts`)
  return counts
}

/** A span's counts narrowed to the watch's reasons; any other reason is what rejectionBuckets calls a reason not on the list. */
function toRejectionCounts(c: SpanCounts, reasons: readonly string[]): RejectionCounts {
  return { runs: c.runs, atStep: c.atStep, failed: c.failed, byReason: Object.fromEntries(reasons.map((r) => [r, c.byReason[r] ?? 0])) }
}

/**
 * One read, never rows (the 1,000 row cap): the function returns a single row
 * of counts. Throws when it cannot be read, so a run that cannot judge fails.
 */
export async function readRejectionCounts(supabase: SupabaseClient, watch: RejectionWatch, from: Date, to: Date): Promise<RejectionCounts> {
  return toRejectionCounts(await readSpanCounts(supabase, watch, from, to), watch.reasons)
}

export interface BaselineDay {
  from: Date
  to: Date
}

const DAY_MS = 24 * 3_600_000

/**
 * The baseline's days: the BASELINE_DAYS whole days ending at the last
 * BASELINE_DAY_ENDS_UTC_HOUR at or before the window's start, oldest first.
 * A `since` drops the days before it and cuts the one it falls in, so no run
 * before it is read; a since after the last day's end leaves no days.
 */
export function baselineDays(windowStart: Date, since?: number): BaselineDay[] {
  const t = windowStart.getTime()
  let end = Math.floor(t / DAY_MS) * DAY_MS + BASELINE_DAY_ENDS_UTC_HOUR * 3_600_000
  if (end > t) end -= DAY_MS
  const days: BaselineDay[] = []
  for (let k = BASELINE_DAYS; k >= 1; k--) {
    const dayEnd = end - (k - 1) * DAY_MS
    const dayStart = Math.max(dayEnd - DAY_MS, since ?? Number.NEGATIVE_INFINITY)
    if (dayStart < dayEnd) days.push({ from: new Date(dayStart), to: new Date(dayEnd) })
  }
  return days
}

/** How long a counted day is kept: past the last hour the baseline can still reach it. */
export const BASELINE_DAY_TTL_SECONDS = (BASELINE_DAYS + 2) * 24 * 3_600

/** The version names what a kept day holds, so a change to what is counted never reads an old one. */
function baselineDayKey(watch: RejectionWatch, day: BaselineDay): string {
  return `${LEAD_VALIDATION_REJECTION_SIGNAL}-baseline-day:v1:${watch.workflowId}:${watch.namespace}:${day.from.toISOString()}:${day.to.toISOString()}`
}

/**
 * The baseline, summed from its days. A day already kept is not read again; a
 * day not kept (or kept as anything but a whole set of counts) is counted, one
 * day per read, one read at a time, and then kept. A run that started in a day
 * and was still running when the day was counted is not in it: the day ends at
 * least SETTLE_MS plus a window before it is first counted, as the window's
 * runs do. KV failing is logged and costs only the recount; a count that
 * cannot be read throws.
 */
export async function readBaselineCounts(supabase: SupabaseClient, kv: RecoveryKv, watch: RejectionWatch, days: readonly BaselineDay[]): Promise<RejectionCounts> {
  const total: SpanCounts = { runs: 0, atStep: 0, failed: 0, byReason: {} }
  for (const day of days) {
    const key = baselineDayKey(watch, day)
    let counts: SpanCounts | null = null
    try {
      const kept = await kv.get(key)
      if (kept !== null) {
        try { counts = spanCountsOf(JSON.parse(kept)) } catch { counts = null }
      }
    } catch (e) {
      console.error(`[${LEAD_VALIDATION_REJECTION_JOB}] reading kept baseline day ${key} failed, counting it: ${formatErr(e)}`)
    }
    if (!counts) {
      counts = await readSpanCounts(supabase, watch, day.from, day.to)
      try {
        await kv.put(key, JSON.stringify(counts), { expirationTtl: BASELINE_DAY_TTL_SECONDS })
      } catch (e) {
        console.error(`[${LEAD_VALIDATION_REJECTION_JOB}] keeping baseline day ${key} failed, it will be counted again: ${formatErr(e)}`)
      }
    }
    total.runs += counts.runs
    total.atStep += counts.atStep
    total.failed += counts.failed
    for (const [r, n] of Object.entries(counts.byReason)) total.byReason[r] = (total.byReason[r] ?? 0) + n
  }
  return toRejectionCounts(total, watch.reasons)
}

// ── The check ───────────────────────────────────────────────────────────────

export interface RejectionWatchSummary {
  judged: Array<{ workflowId: string; state: RejectionVerdict['state']; runs: number; baselineRuns?: number }>
  paged: string[]
  /** Workflows whose page was due this run and did not reach Slack (#3056). */
  undelivered: string[]
  allClear: string[]
}

/** Every hour: judge each watched workflow's last two hours and page, hold or stand down. */
export async function runLeadValidationRejectionWatch(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
  now: number = Date.now(),
  watches: readonly RejectionWatch[] = REJECTION_WATCHES,
): Promise<RejectionWatchSummary> {
  const summary: RejectionWatchSummary = { judged: [], paged: [], undelivered: [], allClear: [] }
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, LEAD_VALIDATION_REJECTION_JOB, 'measure-from-database'))
  if (orgIds.length === 0) return summary
  const workflows = await readActiveWorkflows<Pick<ActiveWorkflowRow, 'id' | 'name' | 'organization_id' | 'slack_channel'>>(
    supabase, 'id, name, organization_id, slack_channel', `${LEAD_VALIDATION_REJECTION_JOB} workflows`, orgIds,
  )
  const byId = new Map(workflows.map((w) => [w.id, w]))

  const windowEnd = new Date(now - SETTLE_MS)
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MINUTES * 60 * 1000)

  for (const watch of watches) {
    const wf = byId.get(watch.workflowId)
    if (!wf) continue
    // Only a full UTC time: Date.parse alone reads text like "version 39" as the year 39.
    const since = watch.baselineSince && ISO_UTC.test(watch.baselineSince) ? Date.parse(watch.baselineSince) : Number.NaN
    if (watch.baselineSince !== undefined && Number.isNaN(since)) throw new Error(`${LEAD_VALIDATION_REJECTION_JOB}: baselineSince ${watch.baselineSince} is not a time`)
    const days = baselineDays(windowStart, Number.isNaN(since) ? undefined : since)
    const current = await readRejectionCounts(supabase, watch, windowStart, windowEnd)
    // A thin window is not judged, so the baseline is not read for it.
    const verdict = current.runs < REJECTION_RULE.minRuns
      ? judgeRejectionShares(current, current)
      : judgeRejectionShares(current, await readBaselineCounts(supabase, kv, watch, days))
    summary.judged.push({ workflowId: wf.id, state: verdict.state, runs: verdict.runs, ...(verdict.state === 'unjudged' ? {} : { baselineRuns: verdict.baselineRuns }) })

    const cooldownKey = `${LEAD_VALIDATION_REJECTION_SIGNAL}-cooldown:${wf.id}`
    const incident: IncidentContext = { scope: { kind: 'org', organizationId: wf.organization_id }, subjectLabel: wf.name }

    if (verdict.state === 'unjudged' || verdict.state === 'unmeasured') {
      // Neither a sighting nor a recovery: an open incident is kept through a
      // night with no leads, never stood down by it (#1803).
      await refreshAlerted(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id)
      continue
    }

    if (verdict.state === 'normal') {
      const cleared = await announceRecovery(
        kv,
        LEAD_VALIDATION_REJECTION_SIGNAL,
        wf.id,
        cooldownKey,
        incident,
        async (alertedAt, endedAt, firstHealthyAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id)
          if (!slack) return false
          return sendRecoveryAlert(slack, wf.slack_channel ?? slack.default_channel, {
            signal: LEAD_VALIDATION_REJECTION_RECOVERY_WORDS,
            subject: wf.name,
            alertedAt,
            endedAt,
            firstHealthyAt,
            measuredWindowMinutes: WINDOW_MINUTES,
            recoveredPhrase: 'is rejecting leads at the shares of the days before again',
            url: `${appUrl}/workflows/${wf.id}`,
          }, 'lead-validation-rejection-rate-all-clear')
        },
        // A whole window past the last shift, so the all-clear is judged on
        // hours that hold none of it.
        { now, rearmMinutes: WINDOW_MINUTES },
      )
      if (cleared) summary.allClear.push(wf.id)
      continue
    }

    console.log(`[${LEAD_VALIDATION_REJECTION_JOB}] shifted workflow_id=${wf.id} runs=${verdict.runs} ${verdict.shifts.map((s) => `${s.bucket}:${s.direction}:${s.count}`).join(' ')}`)
    await markSpikeSeen(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, now)
    if ((await kv.get(cooldownKey)) !== null) continue
    const slack = await getSlackConnection(supabase, wf.organization_id)
    const sent = slack !== null && await sendLeadValidationRejectionAlert(slack, wf.slack_channel ?? slack.default_channel, {
      workflow_id: wf.id,
      workflow_name: wf.name,
      namespace: watch.namespace,
      runs: verdict.runs,
      baseline_runs: verdict.baselineRuns,
      // The span the baseline covered, which a baselineSince can make shorter than a week (L11).
      baseline_days: days.length ? Math.round((days[days.length - 1].to.getTime() - days[0].from.getTime()) / DAY_MS * 10) / 10 : 0,
      shifts: verdict.shifts,
      window_minutes: WINDOW_MINUTES,
      window_end: windowEnd.toISOString(),
      app_url: appUrl,
    })
    // The marker before the cooldown (#2058): a cut between them costs at worst
    // a repeated page, never a lost all-clear. Armed only on delivery, so no
    // all-clear follows a page nobody saw; no cooldown either, so a refused page
    // is tried again next hour.
    if (sent) await markAlerted(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, incident, now)
    // Delivered or refused, the record keeps the incident that was due (#3056).
    // With no Slack connection to send through no page was tried, so nothing
    // is recorded; a send that throws fails the run instead.
    if (slack !== null) await recordPageOutcome(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, incident, now, sent, { sameIncidentWithinMinutes: 2 * 60 })
    if (sent) {
      await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
      summary.paged.push(wf.id)
    } else if (slack === null) {
      console.error(`[${LEAD_VALIDATION_REJECTION_JOB}] page not tried workflow_id=${wf.id}: no Slack connection could be read; tried again next hour`)
    } else {
      console.error(`[${LEAD_VALIDATION_REJECTION_JOB}] page not delivered workflow_id=${wf.id}: Slack did not take it; tried again next hour`)
      summary.undelivered.push(wf.id)
    }
  }
  return summary
}

/** What the run's job_runs row says. Exported for its tests. */
export function leadValidationRejectionEnding(s: RejectionWatchSummary): JobRunEnding {
  const judged = s.judged.filter((j) => j.state === 'normal' || j.state === 'shifted')
  return {
    // A page that was due and reached nobody is the run's first fact (#3056),
    // never ok. A run that judged nothing (no leads, no Slack, the workflow
    // switched off) is recorded as unmeasured, never as ok (L557).
    outcome: s.undelivered.length ? 'page_not_delivered' : judged.length ? 'ok' : 'unmeasured',
    summary: { judged: s.judged, paged: s.paged, undelivered: s.undelivered, all_clear: s.allClear },
  }
}

/** The scheduled entry: the check under a job run record. */
export function runLeadValidationRejectionWatchForEnv(supabase: SupabaseClient, kv: RecoveryKv, appUrl: string): Promise<RejectionWatchSummary> {
  return withJobRun(supabase, LEAD_VALIDATION_REJECTION_JOB, () => runLeadValidationRejectionWatch(supabase, kv, appUrl), leadValidationRejectionEnding)
}
