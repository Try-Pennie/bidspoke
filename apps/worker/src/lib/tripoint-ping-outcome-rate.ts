/**
 * BRIDGE (#2392). Retire it in the #1414 change that removes the tripoint_ping
 * node: delete this file and its test, its block in index.ts and its CRON_JOBS
 * entry in cron-heartbeat.ts. Once Engine's Tripoint leads go through
 * buyer_select they write buyer_sales rows, and buyer-outcome-rate judges them
 * with the same rule. The test fails when the kept tripoint_ping script is
 * gone, to say so.
 *
 * Tripoint's outcome rate on the Engine Bidding tripoint_ping step, every 15
 * minutes. From 10:22 PM ET on 2026-10-13 Tripoint stopped accepting Engine
 * leads asking for less than $2,000, its accept share fell from 57% to 33%, and
 * nothing alerted: buyer-outcome-rate reads buyer_sales, which only buyer_select
 * writes, and the tripoint_ping code node writes none.
 *
 * The rule is buyer-outcome-rate's own (outcome-rate-rule.ts, L370): the share
 * of the last hour's sends that failed, and the share Tripoint declined, each
 * elevated at 25 points above its share over the 14 Eastern days before today.
 * Once the page stands it holds until the share falls back under 12.5 points
 * above (#2421), so the Oct 14 swing between 18 and 33 points is one page.
 * Answers are classed the way the buyer_select node classes Tripoint's, so the
 * shares mean the same thing after #1414: accepted; declined, in_progress
 * (1009), invalid_data and null_id_fault are a decline; anything else (unknown,
 * or an answer this list does not name) failed. A skipped step sent nothing
 * and counts in neither side of any share.
 *
 * Reads are head counts of execution_steps, never rows (the 1,000 row cap),
 * bounded on started_at, which the index leads with, and execution_started_at,
 * which the table is partitioned on. A whole day of these counts took 21.8 s
 * cold on 2026-10-18 (34,556 buffers read for one count), too close to the 30 s
 * statement limit to repeat 14 days every 15 minutes, so the baseline is built
 * from hours: each finished clock hour is counted once, while its rows are
 * still warm, and kept in KV; a finished day is then sealed into one entry.
 * The baseline therefore holds only hours this job recorded, and the page says
 * how many (L11). It starts empty, and is unmeasured until it holds 1,000 sends.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { easternDayStartUtc, easternParts } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import type { BackoffKv } from './alert-backoff'
import { ENGINE_BIDDING_WORKFLOW_ID } from './engine-script-drift'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { failedRun, type FailedRun } from './minute-job-failures'
import { isoDateMinus, judgeOutcomeShares, percent, verdictMovesThePage, type OutcomeBaseline, type OutcomeRateRule, type OutcomeRateVerdict, type BaselineUnreadable } from './outcome-rate-rule'
import { TRIPOINT_ANSWER_NAMESPACE } from './upstream-outage'

/** The heartbeat, job_runs and alerter name: distinct from buyer-outcome-rate, so each page mutes alone. */
export const TRIPOINT_PING_OUTCOME_RATE_JOB = 'tripoint-ping-outcome-rate'

/** tripoint_answer values buyer_select would class as Tripoint declining the lead. */
export const TRIPOINT_DECLINE_ANSWERS = ['declined', 'in_progress', 'invalid_data', 'null_id_fault'] as const
/** tripoint_answer values that are not a send at all. */
export const TRIPOINT_SENT_ANSWERS_EXCLUDED = ['skipped'] as const

/**
 * The floors, sized from the measured hours (L716), the rule shared.
 *
 * Sends an hour, measured 2026-10-13 to 17: 37 to 227 before the Engine $2,000
 * minimum (about 2,400 to 3,100 a day), 12 to 141 after it (1,255 to 1,726 a
 * day), the hours under 40 all between 11 PM and 8 AM ET. Tripoint declines
 * about 42% of what it is sent. At 40 sends one hour's decline share has a
 * standard deviation of about 8 points, so the 25 point rise is about three of
 * them, roughly one ordinary hour in 1,500; at buyer-outcome-rate's 10 it would
 * be 16 points, and an ordinary hour would page about one time in 20. On Oct 16
 * and 17 no hour of 40 or more rose more than 17 points above even a 40%
 * baseline, while on Oct 14 13 of the 23 hours that had 40 did page.
 *
 * Below 40 the hour is quiet unless it saturates (L139): every send failed,
 * from 3, as for every buyer, or nothing was accepted, from 12. At the 42%
 * decline share, 12 sends with no accept is about 3 in 100,000; the thinnest
 * night hour after the minimum held 12 sends. That is while no page stands;
 * while one does, an hour under 40 is judged against the clear line instead
 * (#2421): held if its share is still above it, quiet once it is back under,
 * and never raised on its own. Oct 14's 3 AM ET hour, 38 sends at 66%
 * declined, holds the page that way.
 *
 * The baseline needs 1,000 sends, under one day at either volume.
 */
export const TRIPOINT_PING_RULE: OutcomeRateRule = {
  minAttempts: 40,
  saturationMinAttempts: 3,
  noAcceptSaturationMinAttempts: 12,
  baselineMinAttempts: 1_000,
  baselineDays: 14,
}

/** The judged hour ends this long before now: a step is written once it finishes, and tripoint_ping can run 20 s. */
export const SETTLE_MS = 2 * 60 * 1000
/** How many finished clock hours back a run records any it has not, so a missed run or two leaves no hole. */
export const ROLLUP_LOOKBACK_HOURS = 3
/** How long before the window a counted step's execution may have started; the partition bound must not drop it. */
const EXECUTION_START_SLACK_MS = 10 * 60 * 1000
const HOUR_MS = 3_600_000
/** Long enough for the oldest baseline day to outlive its window. */
const ROLLUP_TTL_SECONDS = (TRIPOINT_PING_RULE.baselineDays + 2) * 24 * 3600

/**
 * Set while this check's page stands (#2421), the way buyer-outcome-rate keeps
 * one per buyer: the shared rule holds a standing page until the share falls
 * well back, and this is how the check knows one stands.
 */
export const PAGE_STANDING_KEY = 'tripoint-ping-outcome:paged'
/** How long the marker outlives the last run that set or kept it; every run renews it while the page stands. */
const PAGE_STANDING_TTL_SECONDS = 24 * 3600

export const TRIPOINT_PING_OUTCOME_RATE_REMEDY: AlertRemedy = {
  consequence:
    'Tripoint failed or declined an unusual share of the Engine leads the tripoint_ping step sent it in the last hour. ' +
    'A decline is an expected answer, so no outage alert counts it, and these leads write no buyer_sales row, so the buyer ' +
    'outcome rate cannot see them. The line says what was measured:',
  fixHint:
    'A run of failed attempts: read unknown_reason on the newest tripoint_ping steps; a 5xx or a timeout is the Tripoint ' +
    'proxy, and the Tripoint outage page counts the same steps. A run of declines: compare the declined leads with what ' +
    'Tripoint takes and ask Tripoint whether its intake rules changed. On 2026-10-14 it stopped taking loans under $2,000.',
  headlineVerb: 'shows Tripoint failing or declining an unusual share of Engine leads',
}

// ── Counts ──────────────────────────────────────────────────────────────────

/** One window of tripoint_ping steps: sends, and of those, accepted, declined and failed. */
export interface PingCounts {
  sent: number
  accepted: number
  declined: number
  failed: number
}

/**
 * The four head counts into sends. Failed is everything sent that was neither
 * accepted nor declined, so an answer value nobody listed reads as a failure,
 * never as nothing (L90). Counts that cannot add up are refused.
 */
export function pingCountsFrom(c: { total: number; skipped: number; accepted: number; declined: number }): PingCounts {
  const sent = c.total - c.skipped
  const failed = sent - c.accepted - c.declined
  if (sent < 0 || failed < 0) {
    throw new Error(`tripoint_ping counts do not add up: ${c.total} steps, ${c.skipped} skipped, ${c.accepted} accepted, ${c.declined} declined`)
  }
  return { sent, accepted: c.accepted, declined: c.declined, failed }
}

export const hourKey = (hourBucket: number) => `tripoint-ping-outcome:hour:${hourBucket}`
export const dayKey = (etDay: string) => `tripoint-ping-outcome:day:${etDay}`

interface DayRollup {
  attempts: number
  failed: number
  declined: number
  hours: number
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** A stored value that will not parse is refused, never read as zero (L50). */
function parseHour(raw: string, key: string): PingCounts {
  let v: Partial<PingCounts>
  try { v = JSON.parse(raw) as Partial<PingCounts> } catch { throw new Error(`${key} holds unreadable JSON`) }
  if (!isCount(v.sent) || !isCount(v.accepted) || !isCount(v.declined) || !isCount(v.failed)) throw new Error(`${key} holds no counts`)
  return { sent: v.sent, accepted: v.accepted, declined: v.declined, failed: v.failed }
}

function parseDay(raw: string, key: string): DayRollup {
  let v: Partial<DayRollup>
  try { v = JSON.parse(raw) as Partial<DayRollup> } catch { throw new Error(`${key} holds unreadable JSON`) }
  if (!isCount(v.attempts) || !isCount(v.failed) || !isCount(v.declined) || !isCount(v.hours)) throw new Error(`${key} holds no counts`)
  return { attempts: v.attempts, failed: v.failed, declined: v.declined, hours: v.hours }
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface PingDeps {
  /** Head counts of the Engine workflow's live tripoint_ping steps started inside [fromMs, toMs). */
  countSends(fromMs: number, toMs: number): Promise<PingCounts>
  kv: BackoffKv
  notify(lines: string[]): Promise<void>
  now(): number
  localDev: boolean
  appUrl: string
  log(line: string): void
}

export interface PingSummary {
  skipped?: 'local_dev'
  window: { from: string; to: string; counts: PingCounts | null }
  baseline: { attempts: number; hours: number } | null
  verdict: OutcomeRateVerdict
  rolled_up_hours: number
  rollup_errors: string[]
  lines: string[]
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')

/** Record each finished clock hour of the lookback that is not yet in KV. */
async function rollUpHours(deps: PingDeps, now: number): Promise<{ recorded: number; errors: string[] }> {
  const thisHour = Math.floor(now / HOUR_MS)
  const errors: string[] = []
  let recorded = 0
  for (let h = thisHour - ROLLUP_LOOKBACK_HOURS; h < thisHour; h++) {
    if (now - SETTLE_MS < (h + 1) * HOUR_MS) continue
    const key = hourKey(h)
    try {
      if ((await deps.kv.get(key)) !== null) continue
      const counts = await deps.countSends(h * HOUR_MS, (h + 1) * HOUR_MS)
      await deps.kv.put(key, JSON.stringify(counts), { expirationTtl: ROLLUP_TTL_SECONDS })
      recorded += 1
    } catch (err) {
      errors.push(`the hour from ${new Date(h * HOUR_MS).toISOString()}: ${messageOf(err)}`)
    }
  }
  return { recorded, errors }
}

/**
 * One past Eastern day's recorded hours. A day whose last hour can no longer be
 * recorded is sealed into one entry, so later runs read one key, not 24. Every
 * run seals the same sum, so a run that overlaps another writes the same value.
 */
async function readDay(deps: PingDeps, day: string, now: number): Promise<DayRollup> {
  const sealedKey = dayKey(day)
  const sealed = await deps.kv.get(sealedKey)
  if (sealed !== null) return parseDay(sealed, sealedKey)
  const first = Math.floor(easternDayStartUtc(day) / HOUR_MS)
  const next = Math.floor(easternDayStartUtc(isoDateMinus(day, -1)) / HOUR_MS)
  const hours = Array.from({ length: next - first }, (_, i) => first + i)
  const raws = await Promise.all(hours.map((h) => deps.kv.get(hourKey(h))))
  const sum: DayRollup = { attempts: 0, failed: 0, declined: 0, hours: 0 }
  raws.forEach((raw, i) => {
    if (raw === null) return
    const c = parseHour(raw, hourKey(hours[i]))
    sum.attempts += c.sent
    sum.failed += c.failed
    sum.declined += c.declined
    sum.hours += 1
  })
  if (now >= (next + ROLLUP_LOOKBACK_HOURS + 1) * HOUR_MS) {
    await deps.kv.put(sealedKey, JSON.stringify(sum), { expirationTtl: ROLLUP_TTL_SECONDS })
  }
  return sum
}

async function readBaseline(deps: PingDeps, now: number): Promise<OutcomeBaseline & { hours: number }> {
  const today = easternParts(now).date
  const days = Array.from({ length: TRIPOINT_PING_RULE.baselineDays }, (_, i) => isoDateMinus(today, i + 1))
  const rollups = await Promise.all(days.map((d) => readDay(deps, d, now)))
  const total = rollups.reduce((a, r) => ({ attempts: a.attempts + r.attempts, failed: a.failed + r.failed, declined: a.declined + r.declined, hours: a.hours + r.hours }), { attempts: 0, failed: 0, declined: 0, hours: 0 })
  const hoursWord = total.hours === 1 ? 'recorded hour' : 'recorded hours'
  return { ...total, span: `${total.hours} ${hoursWord} of the prior ${TRIPOINT_PING_RULE.baselineDays} days` }
}

export async function runTripointPingOutcomeRate(deps: PingDeps): Promise<PingSummary> {
  const now = deps.now()
  const windowTo = now - SETTLE_MS
  const windowFrom = windowTo - HOUR_MS
  const window = { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString(), counts: null as PingCounts | null }

  if (deps.localDev) {
    deps.log(`[${TRIPOINT_PING_OUTCOME_RATE_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', window, baseline: null, verdict: { verdict: 'unmeasured', reason: 'local dev' }, rolled_up_hours: 0, rollup_errors: [], lines: [] }
  }

  const rollup = await rollUpHours(deps, now)

  let baseline: (OutcomeBaseline & { hours: number }) | BaselineUnreadable
  try {
    baseline = await readBaseline(deps, now)
  } catch (err) {
    baseline = { unreadable: messageOf(err) }
  }
  const baselineSummary = 'unreadable' in baseline ? null : { attempts: baseline.attempts, hours: baseline.hours }

  // Whether the page stands, from this check's own marker (#2421): the rule
  // holds a standing page until the share falls well back. A marker that cannot
  // be read leaves the hour unmeasured, so it neither raises nor clears.
  let standing: string | null = null
  let standingUnreadable: string | null = null
  try {
    standing = await deps.kv.get(PAGE_STANDING_KEY)
  } catch (err) {
    standingUnreadable = messageOf(err)
  }

  let verdict: OutcomeRateVerdict
  try {
    window.counts = await deps.countSends(windowFrom, windowTo)
    verdict = standingUnreadable !== null
      ? { verdict: 'unmeasured', reason: `whether a page is standing could not be read: ${standingUnreadable}` }
      : judgeOutcomeShares({ attempts: window.counts.sent, failed: window.counts.failed, declined: window.counts.declined }, baseline, TRIPOINT_PING_RULE, standing !== null)
  } catch (err) {
    verdict = { verdict: 'unmeasured', reason: `the last hour's tripoint_ping steps could not be counted: ${messageOf(err)}` }
  }

  const lines: string[] = []
  if (verdict.verdict === 'elevated' && window.counts) {
    const c = window.counts
    let accepted = `${c.accepted} of the ${c.sent} sends were accepted`
    if (!('unreadable' in baseline) && baseline.attempts >= TRIPOINT_PING_RULE.baselineMinAttempts && c.sent >= TRIPOINT_PING_RULE.minAttempts) {
      const baseAccepted = baseline.attempts - baseline.failed - baseline.declined
      accepted += `, ${percent(c.accepted / c.sent)} against ${percent(baseAccepted / baseline.attempts)} over ${baseline.span}`
    }
    lines.push(`tripoint on the Engine Bidding tripoint_ping step: ${verdict.detail}; ${accepted}. Partner page: ${deps.appUrl}/partners?selected=tripoint`)
  }

  // The marker follows the page: a raise sets it, an hour that moves nothing
  // (held, or unmeasured) keeps a standing one alive so it cannot lapse by
  // expiry, and an hour that clears deletes it.
  if (verdict.verdict === 'elevated') {
    await deps.kv.put(PAGE_STANDING_KEY, new Date(now).toISOString(), { expirationTtl: PAGE_STANDING_TTL_SECONDS })
  } else if (!verdictMovesThePage(verdict)) {
    if (standing !== null) await deps.kv.put(PAGE_STANDING_KEY, standing, { expirationTtl: PAGE_STANDING_TTL_SECONDS })
  } else if (standing !== null) {
    await deps.kv.delete(PAGE_STANDING_KEY)
  }

  // An hour it could not measure says nothing about a standing page, and a
  // held hour is one that keeps it, so neither clears it nor raises one; any
  // other measured hour clears or raises (L11, #2421).
  if (verdictMovesThePage(verdict)) await deps.notify(lines)

  return { window, baseline: baselineSummary, verdict, rolled_up_hours: rollup.recorded, rollup_errors: rollup.errors, lines }
}

/** What the run records about itself: ok only when the hour was judged clean and every finished hour was recorded. */
export function endingOf(s: PingSummary): JobRunEnding {
  const summary = { window: s.window, baseline: s.baseline, verdict: s.verdict.verdict, rolled_up_hours: s.rolled_up_hours, rollup_errors: s.rollup_errors.length }
  if (s.skipped) return { outcome: 'skipped', detail: s.skipped, summary }
  if (s.verdict.verdict === 'elevated' || s.verdict.verdict === 'held') return { outcome: 'findings', detail: s.verdict.detail, summary }
  if (s.verdict.verdict === 'unmeasured') return { outcome: 'unmeasured', detail: s.verdict.reason, summary }
  if (s.rollup_errors.length > 0) {
    return { outcome: 'unmeasured', detail: `${s.rollup_errors.length} finished hours could not be recorded for the baseline: ${s.rollup_errors.join('; ')}`, summary }
  }
  return { outcome: 'ok', detail: s.verdict.detail, summary }
}

/** The line a run with hours it could not record writes, which the failing job page names (#2529). */
export const PING_HOURS_NOT_RECORDED_LINE = `[${TRIPOINT_PING_OUTCOME_RATE_JOB}] hours not recorded:`

/**
 * A run with finished hours it could not record, as a failed run for the
 * failing scheduled job count (minute-job-failures.ts, #2529), with the page's
 * own words, since the run did not stop at an error and its hour was judged.
 * Nothing else pages it: notify carries only the rate's own lines, and job_runs
 * records such a run as unmeasured without paging. Each run retries every hour
 * of the lookback it has not kept, so one failure the next run repairs is not a
 * streak, while three in a row (30 minutes) page well before an hour falls out
 * of the lookback for good. Logs the line it names, with the hours and their
 * errors; the page carries no error text. Undefined when every hour was kept,
 * which a skipped run always reports, since it records nothing.
 */
export function pingRunFailure(s: PingSummary): FailedRun | undefined {
  if (s.rollup_errors.length === 0) return undefined
  console.error(`${PING_HOURS_NOT_RECORDED_LINE} ${s.rollup_errors.join(' | ')}`)
  return failedRun(PING_HOURS_NOT_RECORDED_LINE, {
    fault: 'in each one, at least one finished hour of Tripoint sends on the Engine tripoint_ping step could not be counted and kept for its baseline',
    effect:
      `the hours not kept are missing from the ${TRIPOINT_PING_RULE.baselineDays} day baseline the outcome rate is judged against, ` +
      `and an hour still not kept ${ROLLUP_LOOKBACK_HOURS} hours after it ends is left out of it for good`,
    lookFor: 'which hours could not be kept and the error each one met',
  })
}

// ── Production wiring ───────────────────────────────────────────────────────

export function productionPingDeps(supabase: SupabaseClient, env: Env): PingDeps {
  return {
    countSends: async (fromMs, toMs) => {
      const from = new Date(fromMs).toISOString()
      const to = new Date(toMs).toISOString()
      const executionFrom = new Date(fromMs - EXECUTION_START_SLACK_MS).toISOString()
      // Head counts only: a busy hour holds about 1,500 steps, a day 30,000.
      const steps = () => supabase
        .from('execution_steps')
        .select('id', { count: 'exact', head: true })
        .eq('workflow_id', ENGINE_BIDDING_WORKFLOW_ID)
        .eq('step_namespace', TRIPOINT_ANSWER_NAMESPACE)
        .eq('is_test', false)
        .gte('started_at', from)
        .lt('started_at', to)
        .gte('execution_started_at', executionFrom)
        .lt('execution_started_at', to)
      const counted = async (label: string, q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
        const { count, error } = await q
        if (error) throw new Error(`execution_steps tripoint_ping ${label} count: ${error.message}`)
        if (count === null) throw new Error(`execution_steps tripoint_ping ${label} count came back empty`)
        return count
      }
      const [total, skipped, accepted, declined] = await Promise.all([
        counted('total', steps()),
        counted('skipped', steps().eq('output->>tripoint_answer', TRIPOINT_SENT_ANSWERS_EXCLUDED[0])),
        counted('accepted', steps().eq('output->>tripoint_answer', 'accepted')),
        counted('declined', steps().in('output->>tripoint_answer', [...TRIPOINT_DECLINE_ANSWERS])),
      ])
      return pingCountsFrom({ total, skipped, accepted, declined })
    },
    kv: env.IDEMPOTENCY,
    notify: (lines) => notifyExportFailure(supabase, TRIPOINT_PING_OUTCOME_RATE_JOB, lines, env.IDEMPOTENCY, TRIPOINT_PING_OUTCOME_RATE_REMEDY),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    appUrl: env.APP_URL,
    log: (line) => console.log(line),
  }
}

/** What the scheduled handler calls: the check under a job run record (L557). */
export function runTripointPingOutcomeRateForEnv(supabase: SupabaseClient, env: Env): Promise<PingSummary> {
  return withJobRun(supabase, TRIPOINT_PING_OUTCOME_RATE_JOB, () => runTripointPingOutcomeRate(productionPingDeps(supabase, env)), endingOf)
}
