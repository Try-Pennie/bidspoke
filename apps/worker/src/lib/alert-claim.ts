/**
 * Client side of the alert claim (#1298): the one question a check asks before
 * it posts, "am I the tick that posts this?", answered by a strongly consistent
 * Durable Object rather than by a KV read that two ticks can pass together.
 *
 * The question carries a DEADLINE (#1401). On 2026-09-21 it did not, and the
 * partner reachability probe asked `claim partner-probe-control` and waited
 * 5 minutes 41 seconds for an answer that arrived only as `Network connection
 * lost.`. Cloudflare recorded that invocation as outcome ok, wall time
 * 343,168 ms, CPU time 17 ms: nothing was killed and nothing was working, the
 * caller simply had no way to stop waiting (L110). The cron heartbeat, whose
 * allowance for that job is two minutes, correctly reported the run vanished
 * and paged, with a remedy aimed at a platform kill that had not happened.
 *
 * The fix is a race rather than only an abort signal, because a Durable Object
 * stub is not required to honour one and the caller has to unblock either way.
 * Abandoning the call is safe: nothing awaits the losing arm, and only promises
 * handed to `waitUntil` hold an invocation open, so the run ends on time.
 */
import { formatErr } from './format-error'

export interface AlertClaims {
  /** True for exactly one caller per key per TTL window. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
  /** The claimant could not post; free the key so the next tick can. */
  release(key: string): Promise<void>
}

/**
 * How long a caller waits for the claim object before giving up on it.
 *
 * Below the tightest `maxRunMs` in `cron-heartbeat.ts` (two minutes, the
 * partner reachability probe) by a wide margin, because a check asks this
 * question once and everything else it does is fast: a deadline anywhere near
 * that allowance would still turn one unlucky answer into a vanished run.
 */
export const CLAIM_DEADLINE_MS = 2_000

export interface AlertClaimOptions {
  /** Override the wait before the object is given up on. */
  deadlineMs?: number
  /** The timer seam, so a test never waits in real time (L524). */
  delay?: (ms: number) => Promise<void>
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** What a raced call produced: an answer, a thrown error, or nothing in time. */
type Raced<T> = { kind: 'ok'; value: T } | { kind: 'threw'; error: unknown } | { kind: 'timed_out' }

export function makeAlertClaims(
  ns: DurableObjectNamespace,
  now: () => number = Date.now,
  options: AlertClaimOptions = {},
): AlertClaims {
  const deadlineMs = options.deadlineMs ?? CLAIM_DEADLINE_MS
  const delay = options.delay ?? realDelay
  const stub = (key: string) => ns.get(ns.idFromName(key))

  // Takes the work as a THUNK, not a promise, and calls it inside this async
  // arrow. Looking the object up can throw OUTRIGHT rather than returning a
  // rejected promise, and a promise handed in as an argument has already been
  // built by the time this is entered, so such a throw would escape past the
  // caller entirely. Calling it here makes every failure a rejection, and makes
  // that true for the next call site too rather than for the ones that
  // remembered (L30).
  //
  // The work arm is then folded into a value BEFORE the race, so a call that
  // eventually rejects after losing has already had its rejection handled and
  // cannot surface as an unhandled one long after the check has moved on.
  const race = async <T>(work: () => Promise<T>): Promise<Raced<T>> => {
    const attempt = async (): Promise<T> => work()
    const settled: Promise<Raced<T>> = attempt().then(
      (value) => ({ kind: 'ok', value }),
      (error: unknown) => ({ kind: 'threw' as const, error }),
    )
    const expired: Promise<Raced<T>> = delay(deadlineMs).then(() => ({ kind: 'timed_out' }))
    return Promise.race([settled, expired])
  }

  return {
    async claim(key, ttlSeconds) {
      const outcome = await race(async () => {
        const res = await stub(key).fetch('https://do/claim', {
          method: 'POST',
          body: JSON.stringify({ now: now(), ttl_seconds: ttlSeconds }),
        })
        const body = await res.json<{ claimed?: unknown }>()
        return body.claimed === true
      })
      // Both failures fail OPEN: a claim that cannot be asked must not silence
      // the alert, since the KV cooldown still stands behind it and the worst
      // case is the duplicate this object exists to prevent, never a missing
      // page. They are separate messages because they need separate remedies:
      // a refusal is the object answering, a deadline is it not answering.
      if (outcome.kind === 'timed_out') {
        console.error(`[alert-claim] claim ${key} did not answer inside its ${deadlineMs}ms deadline, posting without it`)
        return true
      }
      if (outcome.kind === 'threw') {
        console.error(`[alert-claim] claim ${key} failed, posting without it: ${formatErr(outcome.error)}`)
        return true
      }
      return outcome.value
    },

    async release(key) {
      const outcome = await race(() => stub(key).fetch('https://do/release', { method: 'POST' }))
      if (outcome.kind === 'timed_out') {
        console.error(`[alert-claim] release ${key} did not answer inside its ${deadlineMs}ms deadline`)
        return
      }
      if (outcome.kind === 'threw') {
        console.error(`[alert-claim] release ${key} failed: ${formatErr(outcome.error)}`)
      }
    },
  }
}
