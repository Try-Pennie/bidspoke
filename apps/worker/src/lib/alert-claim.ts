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
 * Free a claim without ever throwing (#2062): a release that fails must not
 * replace the outcome it follows (a post's error, a refused post, a held
 * all-clear) or stop a check part way through its loop. The claim then lapses
 * at its TTL, and the failure is logged. makeAlertClaims' own release already
 * never throws; this holds every other AlertClaims to the same.
 */
export async function releaseClaimQuietly(claims: AlertClaims | undefined, key: string): Promise<void> {
  if (!claims) return
  try {
    await claims.release(key)
  } catch (e) {
    console.error(`[alert-claim] release ${key} failed: ${formatErr(e)}`)
  }
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
export type Raced<T> = { kind: 'ok'; value: T } | { kind: 'threw'; error: unknown } | { kind: 'timed_out' }

/**
 * Races a call against a deadline, the one implementation the alert claim, the
 * cron tick claim (#1899) and the minute job deadline (#2058, index.ts) use.
 *
 * Takes the work as a THUNK, not a promise, and calls it inside this async
 * arrow. Looking the object up can throw OUTRIGHT rather than returning a
 * rejected promise, and a promise handed in as an argument has already been
 * built by the time this is entered, so such a throw would escape past the
 * caller entirely. Calling it here makes every failure a rejection, and makes
 * that true for the next call site too rather than for the ones that
 * remembered (L30).
 *
 * The work arm is then folded into a value BEFORE the race, so a call that
 * eventually rejects after losing has already had its rejection handled and
 * cannot surface as an unhandled one long after the caller has moved on.
 */
export async function raceDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
  delay: (ms: number) => Promise<void> = realDelay,
): Promise<Raced<T>> {
  const attempt = async (): Promise<T> => work()
  const settled: Promise<Raced<T>> = attempt().then(
    (value) => ({ kind: 'ok', value }),
    (error: unknown) => ({ kind: 'threw' as const, error }),
  )
  const expired: Promise<Raced<T>> = delay(deadlineMs).then(() => ({ kind: 'timed_out' }))
  return Promise.race([settled, expired])
}

/** The claim object's two questions, each raced against the deadline. Shared by both kinds of claim. */
function claimObject(ns: DurableObjectNamespace, now: () => number, options: AlertClaimOptions) {
  const deadlineMs = options.deadlineMs ?? CLAIM_DEADLINE_MS
  const delay = options.delay ?? realDelay
  const stub = (key: string) => ns.get(ns.idFromName(key))
  const race = <T>(work: () => Promise<T>): Promise<Raced<T>> => raceDeadline(work, deadlineMs, delay)
  return {
    deadlineMs,
    ask: (key: string, ttlSeconds: number): Promise<Raced<boolean>> =>
      race(async () => {
        const res = await stub(key).fetch('https://do/claim', {
          method: 'POST',
          body: JSON.stringify({ now: now(), ttl_seconds: ttlSeconds }),
        })
        const body = await res.json<{ claimed?: unknown }>()
        return body.claimed === true
      }),
    async release(key: string): Promise<void> {
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

/** A send claim's answer: won, held by another caller, or the object could not be asked. */
export type SendClaimOutcome = 'claimed' | 'taken' | 'unanswered'

export interface SendClaims {
  claim(key: string, ttlSeconds: number): Promise<SendClaimOutcome>
  release(key: string): Promise<void>
}

/**
 * The claim for a SEND rather than a post (#2023): the Salesforce read-back
 * resends a write only once it holds one. It fails CLOSED, a claim that cannot
 * be asked never sends, because a duplicate resend can regress a record another
 * writer moved while a missed one is tried again next minute. And it says WHY it
 * did not claim, since a caller that counts its attempts must not spend one
 * while the object is down: on 2026-10-15 review, two minutes of an unreachable
 * object would otherwise have used up both of a write's resends with nothing
 * sent.
 */
export function makeSendClaims(ns: DurableObjectNamespace, now: () => number = Date.now, options: AlertClaimOptions = {}): SendClaims {
  const o = claimObject(ns, now, options)
  return {
    async claim(key, ttlSeconds) {
      const outcome = await o.ask(key, ttlSeconds)
      if (outcome.kind === 'timed_out') {
        console.error(`[alert-claim] send claim ${key} did not answer inside its ${o.deadlineMs}ms deadline, not sending`)
        return 'unanswered'
      }
      if (outcome.kind === 'threw') {
        console.error(`[alert-claim] send claim ${key} failed, not sending: ${formatErr(outcome.error)}`)
        return 'unanswered'
      }
      return outcome.value ? 'claimed' : 'taken'
    },
    release: (key) => o.release(key),
  }
}

export function makeAlertClaims(
  ns: DurableObjectNamespace,
  now: () => number = Date.now,
  options: AlertClaimOptions = {},
): AlertClaims {
  const o = claimObject(ns, now, options)
  const deadlineMs = o.deadlineMs

  return {
    async claim(key, ttlSeconds) {
      const outcome = await o.ask(key, ttlSeconds)
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

    release: (key) => o.release(key),
  }
}
