/**
 * Run each cron tick once when Cloudflare delivers it twice (#1899).
 *
 * Since 2026-10-08 13:38:37 UTC Cloudflare delivers every cron tick on the
 * account twice, about 36 s apart, with different scheduled times and separate
 * request ids; on 2026-10-05 21:45 to 23:15 UTC it delivered each tick twice
 * with the SAME scheduled time. Both deliveries ran every job: the lead
 * sightings export ran twice side by side, hourly jobs ran fully twice, and the
 * daily exports and purges would have run twice concurrently.
 *
 * So before any job starts, the scheduled handler claims (cron expression,
 * scheduled minute) from the AlertClaim Durable Object and skips the whole
 * invocation when another delivery holds it. One object per key, so several
 * expressions firing in the same minute are separate claims and all run. The
 * claim is marked done when the run ends, and a delivery carrying the SAME
 * scheduled time as a run that never finished takes over, because that is what
 * Cloudflare's own retry of a killed run looks like (the 14:00:01 hourly run on
 * 2026-10-08 was canceled after 98.6 s and re-run at 14:01:41). The rule and its
 * measurements are on TICK_RETRY_AFTER_MS in the object.
 *
 * Every failure to ask fails OPEN, logged as `FAILED OPEN`: a job run twice is
 * recoverable and a job skipped is not. Every skip is logged as `skipped
 * duplicate` with the holder and the object's running count of duplicates for
 * that tick, so the doubling stays measurable in Workers Logs. Both are also
 * handed to `onGuardEvent`, which counts them so the hourly check in
 * cron-guard-watch.ts can page (#1904).
 */
import type { TickClaimResult } from '../durable-objects/alert-claim'
import { CLAIM_DEADLINE_MS, raceDeadline } from './alert-claim'
import { formatErr } from './format-error'

/** The same short deadline the alert claim uses; well inside any job's allowance. */
export const CRON_TICK_DEADLINE_MS = CLAIM_DEADLINE_MS

export interface CronTickEvent {
  cron: string
  scheduledTime: number
}

export interface CronTickOptions {
  /** The clock, injected so a test can stand at any moment (L524). */
  now?: () => number
  /** This invocation's identity, recorded as the holder. */
  holder?: () => string
  deadlineMs?: number
  /** The deadline's timer seam. */
  delay?: (ms: number) => Promise<void>
  /**
   * Told of each fail-open and each skipped duplicate, so they can be counted
   * and someone paged (#1904). It must not block: the caller hands any write to
   * waitUntil. A throw is logged and never stops the jobs.
   */
  onGuardEvent?: (kind: 'failed_open' | 'skipped_duplicate') => void
}

const MINUTE_MS = 60_000

/** The claim's object name: the expression and the minute, never the second. */
export function cronTickKey(cron: string, scheduledTime: number): string {
  const minute = new Date(Math.floor(scheduledTime / MINUTE_MS) * MINUTE_MS).toISOString().slice(0, 16)
  return `cron-tick:${cron}@${minute}Z`
}

const iso = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms))

type Decision =
  | { run: true; holder: string | null }
  | { run: false }

async function decide(
  ns: DurableObjectNamespace | undefined,
  event: CronTickEvent,
  options: CronTickOptions,
): Promise<Decision> {
  const label = `cron="${event.cron}" scheduled=${iso(event.scheduledTime)}`
  const report = (kind: 'failed_open' | 'skipped_duplicate') => {
    try {
      options.onGuardEvent?.(kind)
    } catch (e) {
      console.error(`[cron-once] could not record ${kind} ${label}: ${formatErr(e)}`)
    }
  }
  const failOpen = (why: string): Decision => {
    console.error(`[cron-once] FAILED OPEN ${label}: ${why}, running without the claim`)
    report('failed_open')
    return { run: true, holder: null }
  }
  if (!ns) return failOpen('no ALERT_CLAIM binding')
  if (!Number.isFinite(event.scheduledTime)) return failOpen('the event carries no scheduled time')

  const deadlineMs = options.deadlineMs ?? CRON_TICK_DEADLINE_MS
  const holder = (options.holder ?? (() => crypto.randomUUID()))()
  const now = (options.now ?? Date.now)()
  const key = cronTickKey(event.cron, event.scheduledTime)
  const outcome = await raceDeadline(async () => {
    const res = await ns.get(ns.idFromName(key)).fetch('https://do/tick-claim', {
      method: 'POST',
      body: JSON.stringify({ now, scheduled_time: event.scheduledTime, holder }),
    })
    if (!res.ok) throw new Error(`claim object answered ${res.status}`)
    const body = await res.json<TickClaimResult>()
    if (typeof body?.run !== 'boolean') throw new Error('claim object answered without a verdict')
    return body
  }, deadlineMs, options.delay)

  if (outcome.kind === 'timed_out') return failOpen(`claim ${key} did not answer inside ${deadlineMs}ms`)
  if (outcome.kind === 'threw') return failOpen(`claim ${key} failed: ${formatErr(outcome.error)}`)

  const verdict = outcome.value
  if (!verdict.run) {
    console.log(
      `[cron-once] skipped duplicate ${label} holder=${verdict.holder} holder_scheduled=${iso(verdict.holder_scheduled_time)}` +
        ` holder_status=${verdict.holder_status} holder_age_ms=${verdict.holder_age_ms} duplicates=${verdict.duplicates}`,
    )
    report('skipped_duplicate')
    return { run: false }
  }
  if (verdict.reason === 'retry') {
    console.warn(`[cron-once] took over a run that did not finish ${label} holder=${holder} previous_holder=${verdict.holder} previous_age_ms=${verdict.holder_age_ms}`)
  } else {
    console.log(`[cron-once] running ${label} holder=${holder}`)
  }
  return { run: true, holder }
}

/** Closes the tick as `done`, or frees it with `release`, for this holder only. */
async function settleTick(
  ns: DurableObjectNamespace,
  event: CronTickEvent,
  holder: string,
  how: 'done' | 'release',
  options: CronTickOptions,
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? CRON_TICK_DEADLINE_MS
  const key = cronTickKey(event.cron, event.scheduledTime)
  const outcome = await raceDeadline(async () => {
    const res = await ns.get(ns.idFromName(key)).fetch(`https://do/tick-${how}`, {
      method: 'POST',
      body: JSON.stringify({ holder }),
    })
    if (!res.ok) throw new Error(`claim object answered ${res.status}`)
  }, deadlineMs, options.delay)
  // Not fatal either way. An unmarked claim lets a later delivery of the same
  // scheduled time take over as a retry after the floor; an unreleased one
  // does the same, so a failed release delays the retry rather than losing it.
  if (outcome.kind === 'timed_out') console.error(`[cron-once] could not ${how} ${key} inside ${deadlineMs}ms`)
  if (outcome.kind === 'threw') console.error(`[cron-once] could not ${how} ${key}: ${formatErr(outcome.error)}`)
}

/**
 * Runs `jobs` unless another delivery of this tick holds it.
 *
 * `jobs` must resolve only once every job it started has settled, and must
 * reject only when the jobs could not run (each job catches its own failures).
 * On resolve the tick is marked done. On reject the tick is RELEASED and the
 * error rethrown, so the invocation fails as it did before the claim existed,
 * Cloudflare can retry it, and a later delivery of the tick is not skipped on
 * the word of a run that never ran anything.
 *
 * If `jobs` threw PART way, after some jobs had already started, the retry runs
 * those again. That is deliberate: in the scheduled handler the only throw that
 * escapes is building the database client, before any job starts, and where it
 * is not, running a job twice is the side to err on, never skipping it.
 */
export async function runCronTickOnce(
  ns: DurableObjectNamespace | undefined,
  event: CronTickEvent,
  jobs: () => Promise<unknown>,
  options: CronTickOptions = {},
): Promise<'ran' | 'skipped'> {
  const decision = await decide(ns, event, options)
  if (!decision.run) return 'skipped'
  try {
    await jobs()
  } catch (e) {
    console.error(`[cron-once] released cron="${event.cron}" scheduled=${iso(event.scheduledTime)}: the jobs threw before finishing: ${formatErr(e)}`)
    if (ns && decision.holder) await settleTick(ns, event, decision.holder, 'release', options)
    throw e
  }
  if (ns && decision.holder) await settleTick(ns, event, decision.holder, 'done', options)
  return 'ran'
}
