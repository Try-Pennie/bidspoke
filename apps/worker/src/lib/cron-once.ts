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
 * measurements are on TICK_LEASE_STALE_MS in the object. While its jobs run the
 * holder renews a lease (#2064), so a same-time delivery can tell a live run
 * from one Cloudflare killed and is retrying.
 *
 * Every failure to ask fails OPEN, logged as `FAILED OPEN`: a job run twice is
 * recoverable and a job skipped is not. Every skip is logged as `skipped
 * duplicate` with the holder and the object's running count of duplicates for
 * that tick, so the doubling stays measurable in Workers Logs. Both are also
 * handed to `onGuardEvent`, which counts them so the hourly check in
 * cron-guard-watch.ts can page (#1904).
 */
import type { TickClaimResult } from '../durable-objects/alert-claim'
import { TICK_LEASE_RENEW_MS, TICK_LEASE_STALE_MS } from '../durable-objects/alert-claim'
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
   * The lease renewal's timer seam (#2064): calls `fn` every `ms` and returns a
   * stop. A killed run's timer never fires again, which is what lets a retry
   * see it is dead. Defaults to setInterval.
   */
  every?: (fn: () => void, ms: number) => () => void
  /** The wait before a same-time delivery asks again (#2064). Its own seam, not `delay`, which is the deadline's. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Told of each fail-open and each skipped duplicate, so they can be counted
   * and someone paged (#1904). It must not block: the caller hands any write to
   * waitUntil. A throw is logged and never stops the jobs. The event's id is
   * also in its log line (#2166): the tail worker copies each `FAILED OPEN`
   * line into the database by that id, a second record written by a different
   * path, so the count survives this record failing.
   */
  onGuardEvent?: (kind: GuardEventKind, event: GuardEventInfo) => void
  /** Names each guard event; the id seam for tests. Defaults to a random UUID. */
  eventId?: () => string
}

export type GuardEventKind = 'failed_open' | 'skipped_duplicate'

export interface GuardEventInfo {
  /** Named in the event's log line as `event=<id>`, so its two records can be matched. */
  id: string
  /** When it happened, by the injected clock. */
  atMs: number
}

const MINUTE_MS = 60_000

/** Past the stale point, so the second ask does not race a renewal that is due. */
const LEASE_MARGIN_MS = 250

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const everyInterval = (fn: () => void, ms: number): (() => void) => {
  const id = setInterval(fn, ms)
  return () => clearInterval(id)
}

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
  const clock = options.now ?? Date.now
  const newEvent = (): GuardEventInfo => ({ id: (options.eventId ?? (() => crypto.randomUUID()))(), atMs: clock() })
  const report = (kind: GuardEventKind, info: GuardEventInfo) => {
    try {
      options.onGuardEvent?.(kind, info)
    } catch (e) {
      console.error(`[cron-once] could not record ${kind} event=${info.id} ${label}: ${formatErr(e)}`)
    }
  }
  const failOpen = (why: string): Decision => {
    const info = newEvent()
    // The tail worker parses this exact shape (apps/worker-tail, #2166), so
    // `event=<id>` stays straight after `FAILED OPEN`.
    console.error(`[cron-once] FAILED OPEN event=${info.id} ${label}: ${why}, running without the claim`)
    report('failed_open', info)
    return { run: true, holder: null }
  }
  if (!ns) return failOpen('no ALERT_CLAIM binding')
  if (!Number.isFinite(event.scheduledTime)) return failOpen('the event carries no scheduled time')

  const deadlineMs = options.deadlineMs ?? CRON_TICK_DEADLINE_MS
  const holder = (options.holder ?? (() => crypto.randomUUID()))()
  const key = cronTickKey(event.cron, event.scheduledTime)
  const ask = (afterWait = false) => raceDeadline(async () => {
    const res = await ns.get(ns.idFromName(key)).fetch('https://do/tick-claim', {
      method: 'POST',
      body: JSON.stringify({ now: clock(), scheduled_time: event.scheduledTime, holder, after_wait: afterWait }),
    })
    if (!res.ok) throw new Error(`claim object answered ${res.status}`)
    const body = await res.json<TickClaimResult>()
    if (typeof body?.run !== 'boolean') throw new Error('claim object answered without a verdict')
    return body
  }, deadlineMs, options.delay)

  let outcome = await ask()
  if (outcome.kind === 'timed_out') return failOpen(`claim ${key} did not answer inside ${deadlineMs}ms`)
  if (outcome.kind === 'threw') return failOpen(`claim ${key} failed: ${formatErr(outcome.error)}`)

  // A same-time delivery that finds the holder running with a fresh lease cannot
  // yet tell a live run from one killed a moment ago (#2064: the retry came
  // 0.4 s after the kill). It waits until a dead holder's lease would be stale
  // and asks once more: a live holder has renewed by then, a dead one has not.
  const first = outcome.value
  if (
    !first.run &&
    first.holder_status === 'running' &&
    first.holder_scheduled_time === event.scheduledTime &&
    typeof first.holder_lease_age_ms === 'number' &&
    first.holder_lease_age_ms < TICK_LEASE_STALE_MS
  ) {
    const waitMs = TICK_LEASE_STALE_MS - first.holder_lease_age_ms + LEASE_MARGIN_MS
    console.log(`[cron-once] waiting ${waitMs}ms on a same-time holder ${label} holder=${first.holder} lease_age_ms=${first.holder_lease_age_ms}`)
    await (options.sleep ?? sleepFor)(waitMs)
    outcome = await ask(true)
    if (outcome.kind === 'timed_out') return failOpen(`claim ${key} did not answer inside ${deadlineMs}ms after waiting on a same-time holder`)
    if (outcome.kind === 'threw') return failOpen(`claim ${key} failed after waiting on a same-time holder: ${formatErr(outcome.error)}`)
  }

  const verdict = outcome.value
  if (!verdict.run) {
    const info = newEvent()
    console.log(
      `[cron-once] skipped duplicate ${label} holder=${verdict.holder} holder_scheduled=${iso(verdict.holder_scheduled_time)}` +
        ` holder_status=${verdict.holder_status} holder_age_ms=${verdict.holder_age_ms} duplicates=${verdict.duplicates} event=${info.id}`,
    )
    report('skipped_duplicate', info)
    return { run: false }
  }
  if (verdict.reason === 'retry') {
    console.warn(`[cron-once] took over a run that did not finish ${label} holder=${holder} previous_holder=${verdict.holder} previous_age_ms=${verdict.holder_age_ms}`)
  } else {
    console.log(`[cron-once] running ${label} holder=${holder}`)
  }
  return { run: true, holder }
}

/** Renews this holder's lease every TICK_LEASE_RENEW_MS; returns the stop. A failed renewal is logged, never thrown. */
function startRenewing(
  ns: DurableObjectNamespace,
  event: CronTickEvent,
  holder: string,
  options: CronTickOptions,
): () => void {
  const deadlineMs = options.deadlineMs ?? CRON_TICK_DEADLINE_MS
  const key = cronTickKey(event.cron, event.scheduledTime)
  const clock = options.now ?? Date.now
  let stop: () => void = () => {}
  let stopped = false
  const halt = () => { if (!stopped) { stopped = true; stop() } }
  const renew = async () => {
    const outcome = await raceDeadline(async () => {
      const res = await ns.get(ns.idFromName(key)).fetch('https://do/tick-renew', {
        method: 'POST',
        body: JSON.stringify({ holder, now: clock() }),
      })
      if (!res.ok) throw new Error(`claim object answered ${res.status}`)
      return res.json<{ renewed?: unknown }>()
    }, deadlineMs, options.delay)
    // A renewal still in flight when this run finished answers after tick-done or
    // tick-release; its refusal or failure says nothing about this run.
    if (stopped) return
    // Not fatal: a lease that goes stale lets a same-time delivery run the tick
    // again, which is the direction to err in.
    if (outcome.kind === 'timed_out') console.error(`[cron-once] could not renew ${key} inside ${deadlineMs}ms`)
    if (outcome.kind === 'threw') console.error(`[cron-once] could not renew ${key}: ${formatErr(outcome.error)}`)
    // Refused: the tick was handed to a retry (this run's renewals had stopped
    // reaching the object), so this run is now the second one. Said once, and
    // renewing stops, because the lease is no longer this run's to keep.
    if (outcome.kind === 'ok' && outcome.value?.renewed === false) {
      console.warn(`[cron-once] renewal of ${key} was refused: the tick was handed to another delivery, holder=${holder} keeps running as a second run`)
      halt()
    }
  }
  stop = (options.every ?? everyInterval)(() => { if (!stopped) void renew() }, TICK_LEASE_RENEW_MS)
  return halt
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
  // Not fatal either way. An unmarked or unreleased claim stops being renewed,
  // so a later delivery of the same scheduled time takes over as a retry once
  // the lease is stale; a failed release delays the retry rather than losing it.
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
  // Renew the lease while the jobs run, so a same-time delivery can tell this run
  // is alive (#2064). A run that was killed stops renewing, and its retry runs.
  const stopRenewing = ns && decision.holder ? startRenewing(ns, event, decision.holder, options) : () => {}
  try {
    await jobs()
  } catch (e) {
    stopRenewing()
    console.error(`[cron-once] released cron="${event.cron}" scheduled=${iso(event.scheduledTime)}: the jobs threw before finishing: ${formatErr(e)}`)
    if (ns && decision.holder) await settleTick(ns, event, decision.holder, 'release', options)
    throw e
  }
  stopRenewing()
  if (ns && decision.holder) await settleTick(ns, event, decision.holder, 'done', options)
  return 'ran'
}
