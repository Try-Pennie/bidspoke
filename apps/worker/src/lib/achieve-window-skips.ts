/**
 * Achieve leads skipped for lack of time, counted per day and paged above a
 * measured rate (#2862, L77).
 *
 * The Achieve step sends nothing when less than ACHIEVE_MIN_WAIT_MS would be left
 * of the 12 s a run keeps working after the answer, once the 500 ms margin is
 * taken off (#2834): its output carries `_achieve_skipped` with the reason
 * `answer_window_spent`, and no evaluation is written. That was only a step output
 * and a log line, so a day when slow steps before Achieve (the outcome write, the
 * inquiry stage of #2176) cost it many leads looked like a quiet day and paged
 * nobody, while Achieve's volume fell.
 *
 * What is judged: of the leads the screen let through on one Eastern day (steps
 * whose output carries the evaluation marker, plus the window skips, which come
 * after the screen), how many were skipped for lack of time. Live runs only; a
 * test run has no window and never skips this way.
 *
 * The rule, measured on 2026-10-30 for the 4 s floor (a skip under 4.5 s left,
 * so a step starting more than 7.5 s after the answer), by each live Achieve
 * step's start against its run's response step. Of 14,683 from Oct 22 to 30, 44
 * (0.30%) started that late, on three days: Oct 26 (1 of 1,607), Oct 28 (13 of
 * 2,026, 0.64%) and Oct 29 (30 of 1,837, 1.63%, a slowdown and the worst day). The
 * other six had none, so on a normal day far fewer than 1 in 100 are skipped. The
 * leads the screen lets through: 62 to 198 a day, median 146, over the 42 days
 * from Sep 1 to Oct 22 with exports in Snowflake. A day pages when at least
 * `minSkips` were skipped and more than `maxShare` of those leads: at the median
 * that is 8 skips. At the whole period's rate a day reaches that about 2 times in
 * 100 million (Poisson), and 4 of 62 at the thinnest day about 4 in 100,000. Even
 * at Oct 29's rate it is about 3 in 1,000 at the median and 2 in 100 at the
 * thinnest, so the rule pages a slowdown well past Oct 29's, not one like it.
 * Every lead skipped pages from 3 (L139). A day nothing passed the screen (Achieve
 * paused, as from Oct 23) is unmeasured: it neither raises nor clears a page.
 *
 * When it runs: hourly, judging the last Eastern day that has ended, once. The
 * day is marked judged only after its verdict reached the alerter, so a count
 * that fails, or an alerter that throws, makes the run fail (counted by
 * completeAfter, paging at two in a row) and the next hour tries the day again.
 * The day is judged SETTLE_MS after it ends, by when its late steps are written.
 *
 * The observe week (L36), as the partner constants reconfirm's: for 7 days it
 * logs and records what it would page without paging. Its start is the first day
 * it MEASURED, not its first run, because Achieve has been paused since Oct 23 and
 * a week of unmeasured days would observe nothing (L557).
 *
 * Each run's counts go to job_runs (`achieve-window-skips`), so the rate this
 * rule rests on can be re-measured from them (L316). It pages through the shared
 * alerter (`export-alert:achieve-window-skips`), muted, reminded and cleared like
 * every scheduled check; a clean day is its all clear.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { easternDayStartUtc, easternParts } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import { ACHIEVE_MIN_WAIT_MS, ACHIEVE_WINDOW_MARGIN_MS, ACHIEVE_WINDOW_SPENT_REASON } from '../engine/nodes/achieve-offers'
import { CONTINUATION_WINDOW_MS } from './post-response-budget'
import { notifyExportFailure, type TitledRemedy } from './export-alerts'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { isoDateMinus, percent } from './outcome-rate-rule'

/** The heartbeat, job_runs and alerter name. */
export const ACHIEVE_WINDOW_SKIPS_JOB = 'achieve-window-skips'

/** The rule, sized from the measurements in the module header. */
export const ACHIEVE_WINDOW_SKIP_RULE = { minSkips: 3, maxShare: 0.05 } as const

/** How long the check records without paging, from the first day it measured (L36). */
export const ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS = 7 * 24 * 60 * 60 * 1000
/** When the first measured day was judged, which starts the observe week. No TTL. */
export const ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY = 'achieve-window-skips:observing-since'
/** Set once a day's verdict has reached the alerter, so the hourly runs judge each day once. */
export const judgedDayKey = (etDay: string) => `achieve-window-skips:judged:${etDay}`
/** Long enough to outlive the day it marks, which is never judged again after the next. */
const JUDGED_TTL_SECONDS = 3 * 24 * 3600
/** A day is judged this long after it ends: a step still running at midnight is written within the run's 30 s. */
export const SETTLE_MS = 10 * 60 * 1000
/** How long before the day a counted step's run may have started; the partition bound must not drop it. */
const EXECUTION_START_SLACK_MS = 10 * 60 * 1000

/** The skip threshold in whole seconds, as the page states it: the margin and the floor together. */
const SECONDS_A_SEND_NEEDS = (ACHIEVE_WINDOW_MARGIN_MS + ACHIEVE_MIN_WAIT_MS) / 1000
const WINDOW_SECONDS = CONTINUATION_WINDOW_MS / 1000

/** The page (#2862), in the words Dan approved on 2026-10-30. */
export const ACHIEVE_WINDOW_SKIPS_REMEDY: TitledRemedy = {
  title: 'Achieve is missing leads because steps before it run slowly',
  context:
    'Achieve never receives these leads. On a normal day fewer than 1 in 100 are skipped this way, ' +
    'so a step that runs before Achieve after the answer, most often a Salesforce write, has slowed down.',
  fixHint:
    'Open one of the day\'s runs in Bidspoke and find the step before Achieve that took several seconds. ' +
    'A slow Salesforce write points to Salesforce, and a step added before Achieve may need to move after it.',
}

/** One Eastern day of live Achieve steps after the screen: sent (the evaluation marker) and skipped for lack of time. */
export interface WindowSkipCounts {
  sent: number
  skipped: number
}

export type WindowSkipVerdict =
  | { verdict: 'unmeasured'; reason: string }
  | { verdict: 'clean'; detail: string }
  | { verdict: 'elevated'; detail: string }

/** The rule. A day with no lead after the screen is unmeasured, never clean (L98). */
export function judgeWindowSkips(c: WindowSkipCounts): WindowSkipVerdict {
  const passed = c.sent + c.skipped
  if (passed === 0) return { verdict: 'unmeasured', reason: 'no lead passed the Achieve screen that day' }
  const share = c.skipped / passed
  const detail = `${c.skipped} of ${passed} leads after the screen skipped (${percent(share)})`
  if (c.skipped >= ACHIEVE_WINDOW_SKIP_RULE.minSkips && share > ACHIEVE_WINDOW_SKIP_RULE.maxShare) return { verdict: 'elevated', detail }
  return { verdict: 'clean', detail }
}

/** "Thu, Oct 29" for 2026-10-29: a calendar day, so formatted in UTC where the date is exact. */
function dayLabel(etDay: string): string {
  const [y, m, d] = etDay.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.UTC(y, m - 1, d))
}

/** The page's finding, with the day's real numbers and the threshold read from the constants (Dan, 2026-10-30). */
export function windowSkipsLine(etDay: string, c: WindowSkipCounts): string {
  const passed = c.sent + c.skipped
  return (
    `On ${dayLabel(etDay)}, ${c.skipped} of the ${passed} leads that passed the Achieve screen (${percent(c.skipped / passed)}) were not sent to Achieve. ` +
    `Each reached the Achieve step with under ${SECONDS_A_SEND_NEEDS} seconds left of the ${WINDOW_SECONDS} seconds a run keeps working after it answers the lead, too little for Achieve to reply.`
  )
}

interface SkipsKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface WindowSkipsDeps {
  /** Head counts of the live Achieve steps started inside [fromMs, toMs). Throws when either cannot be read. */
  countDay(fromMs: number, toMs: number): Promise<WindowSkipCounts>
  kv: SkipsKv
  /** The shared alerter: lines to page, or none as the all clear. */
  notify(lines: string[]): Promise<void>
  now(): number
  localDev: boolean
  log(line: string): void
}

export interface WindowSkipsSummary {
  skipped?: 'local_dev' | 'already_judged'
  day: string
  counts: WindowSkipCounts | null
  verdict: WindowSkipVerdict | null
  /** Set while the observe week runs, when the verdict was not handed to the alerter. */
  observing_until: string | null
  lines: string[]
}

/**
 * When the observe week started, starting it now when none is kept. A kept value
 * that does not parse is logged and read as a week long over (L50): restarting
 * the week would let a damaged record silence the page for seven days.
 */
async function observingSince(kv: SkipsKv, nowMs: number, log: (line: string) => void): Promise<number> {
  const raw = await kv.get(ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY)
  if (raw === null) {
    await kv.put(ACHIEVE_WINDOW_SKIPS_OBSERVING_SINCE_KEY, String(nowMs))
    return nowMs
  }
  const started = Number(raw)
  if (Number.isFinite(started)) return started
  log(`[${ACHIEVE_WINDOW_SKIPS_JOB}] the observe week's start is unreadable, so it is judged over: ${JSON.stringify(raw.slice(0, 40))}`)
  return Number.NEGATIVE_INFINITY
}

export async function runAchieveWindowSkips(deps: WindowSkipsDeps): Promise<WindowSkipsSummary> {
  const now = deps.now()
  // The last Eastern day that ended at least SETTLE_MS ago.
  const day = isoDateMinus(easternParts(now - SETTLE_MS).date, 1)
  const base: WindowSkipsSummary = { day, counts: null, verdict: null, observing_until: null, lines: [] }
  if (deps.localDev) return { ...base, skipped: 'local_dev' }
  if ((await deps.kv.get(judgedDayKey(day))) !== null) return { ...base, skipped: 'already_judged' }

  // A failed count throws on: the run is counted as failed and the day tried again.
  const counts = await deps.countDay(easternDayStartUtc(day), easternDayStartUtc(isoDateMinus(day, -1)))
  const verdict = judgeWindowSkips(counts)
  const lines = verdict.verdict === 'elevated' ? [windowSkipsLine(day, counts)] : []
  let observingUntil: string | null = null

  // An unmeasured day neither raises nor clears, and does not start the observe week.
  if (verdict.verdict !== 'unmeasured') {
    const started = await observingSince(deps.kv, now, deps.log)
    if (now - started < ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS) {
      observingUntil = new Date(started + ACHIEVE_WINDOW_SKIPS_OBSERVE_FOR_MS).toISOString()
      if (lines.length > 0) deps.log(`[${ACHIEVE_WINDOW_SKIPS_JOB}] would page (observing until ${observingUntil}): ${lines.join(' ')}`)
    } else {
      // Throws on: the day stays unjudged and the next run hands it over again.
      await deps.notify(lines)
    }
  }

  await deps.kv.put(judgedDayKey(day), new Date(now).toISOString(), { expirationTtl: JUDGED_TTL_SECONDS })
  return { ...base, counts, verdict, observing_until: observingUntil, lines }
}

/** What the run records about itself in job_runs, the day's counts included. */
export function achieveWindowSkipsEnding(s: WindowSkipsSummary): JobRunEnding {
  const summary = { day: s.day, counts: s.counts, verdict: s.verdict?.verdict ?? null, observing_until: s.observing_until }
  if (s.skipped) return { outcome: 'skipped', detail: s.skipped === 'local_dev' ? 'local dev' : `${s.day} was judged already`, summary }
  const v = s.verdict
  if (v === null) return { outcome: 'unmeasured', detail: 'no verdict', summary }
  if (v.verdict === 'unmeasured') return { outcome: 'unmeasured', detail: `${s.day}: ${v.reason}`, summary }
  if (v.verdict === 'elevated') {
    const prefix = s.observing_until ? `would page (observing until ${s.observing_until}): ` : ''
    return { outcome: 'findings', detail: `${prefix}${s.day}: ${v.detail}`, summary }
  }
  return { outcome: 'ok', detail: `${s.day}: ${v.detail}`, summary }
}

// ── Production wiring ───────────────────────────────────────────────────────

export function productionWindowSkipsDeps(supabase: SupabaseClient, env: Env): WindowSkipsDeps {
  return {
    countDay: async (fromMs, toMs) => {
      const from = new Date(fromMs).toISOString()
      const to = new Date(toMs).toISOString()
      const executionFrom = new Date(fromMs - EXECUTION_START_SLACK_MS).toISOString()
      // Head counts only, bounded on started_at and on execution_started_at, the
      // partition bound. A whole Eastern day took 5.1 s cold on 2026-10-30.
      const steps = () => supabase
        .from('execution_steps')
        .select('id', { count: 'exact', head: true })
        .eq('step_type', 'achieve_offers')
        .eq('is_test', false)
        .gte('started_at', from)
        .lt('started_at', to)
        .gte('execution_started_at', executionFrom)
        .lt('execution_started_at', to)
      const counted = async (label: string, q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
        const { count, error } = await q
        if (error) throw new Error(`execution_steps achieve_offers ${label} count: ${error.message}`)
        if (count === null) throw new Error(`execution_steps achieve_offers ${label} count came back empty`)
        return count
      }
      const [sent, skipped] = await Promise.all([
        counted('sent', steps().eq('output->>_achieve_evaluation', 'true')),
        counted('skipped', steps().eq('output->>reason', ACHIEVE_WINDOW_SPENT_REASON)),
      ])
      return { sent, skipped }
    },
    kv: env.IDEMPOTENCY,
    // Keyed on the job, so a new day of the same problem reads as the same page
    // (reminded, not new) although its day and numbers move (#1768).
    notify: (lines) => notifyExportFailure(supabase, ACHIEVE_WINDOW_SKIPS_JOB, lines, env.IDEMPOTENCY, ACHIEVE_WINDOW_SKIPS_REMEDY, Date.now(), { keys: lines.map(() => ACHIEVE_WINDOW_SKIPS_JOB) }),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    log: (line) => console.log(line),
  }
}

/** What the scheduled handler calls: the check under a job run record (L557). */
export function runAchieveWindowSkipsForEnv(supabase: SupabaseClient, env: Env): Promise<WindowSkipsSummary> {
  return withJobRun(supabase, ACHIEVE_WINDOW_SKIPS_JOB, () => runAchieveWindowSkips(productionWindowSkipsDeps(supabase, env)), achieveWindowSkipsEnding)
}
