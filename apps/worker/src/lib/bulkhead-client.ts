// Client for the BulkheadObject inflight-concurrency limiter (ADR 0005 / #312).
// One DO instance per dependency name (e.g. "salesforce"). `acquire` before the
// dependency call, `release` in a finally. The limit is passed per acquire so it
// stays env-configurable without redeploying the DO.

import type { AcquireResult } from '../durable-objects/bulkhead'
import type { Env } from '../index'
import { formatErr } from './format-error'

export type { AcquireResult }

const DEFAULT_LIMIT = 20
// How long a caller will wait for a slot before shedding. Bursts observed in
// prod cleared within seconds to a minute (2026-07-01..07-03: 16 leads shed;
// 2026-07-22: a ~1-min Salesforce latency spike dropped 17 leads that gave up
// after 5s even though slots kept freeing throughout). Raised to 15s so a lead
// rides out a short slowdown instead of shedding. A waiting request never
// touches the protected dependency, so waiting is safe for Salesforce; it only
// defers our own call, and the 30s step timeout still bounds the total wait.
const DEFAULT_WAIT_MS = 15_000
const POLL_MS = 250

/** Resolve the configured Salesforce inflight cap (env override, sane default). */
export function salesforceBulkheadLimit(env: Env): number {
  const raw = env.SALESFORCE_BULKHEAD_LIMIT
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT
}

/** Resolve the configured at-capacity wait budget (env override, sane default). 0 = shed instantly. */
export function salesforceBulkheadWaitMs(env: Env): number {
  const raw = env.SALESFORCE_BULKHEAD_WAIT_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_WAIT_MS
}

/** The key every Salesforce call takes: the whole self-imposed cap, unchanged by #2170. */
export const SALESFORCE_BULKHEAD_KEY = 'salesforce'

/**
 * The key a Salesforce call made after the run's answer takes as well (#2170,
 * phase 1 of #1680). It caps post-answer work at a SHARE of the main cap: a
 * post-answer call holds a slot here and a slot of the main key, so together the
 * two keys never let more calls reach Salesforce than the main cap alone did,
 * and post-answer work can never hold more than its share of it. Pre-answer
 * calls always find the rest (at the default cap of 20, the other 14; at any cap
 * of 2 or more, one at least, see `salesforceBulkheads`). Since #2847 the
 * collections post may hold 3 of those 14, so the trades call and every other
 * pre-answer call are guaranteed 11 at the default cap.
 */
export const SALESFORCE_POST_ANSWER_BULKHEAD_KEY = 'salesforce-post-answer'

/**
 * How many of the main cap's slots post-answer calls may hold at once (#2170).
 *
 * Measured over 2026-10-08 to 10-15 (docs/salesforce-post-answer-write-contract.md,
 * "Bulkhead peak in flight"): 0 sheds, one peak at 20 of 20 on 10-11, otherwise a
 * highest of 11 to 13 on the logged waits. Post-answer writes are about 54,300 of
 * the 142,000 to 191,000 Salesforce steps a day, and the Main Flow port adds about
 * 9,500, so about 36% of calls. At that mix the 10-11 peak was about 7
 * post-answer and 13 pre-answer calls, and an ordinary day's peak about 5 and 8.
 * Six covers an ordinary day's post-answer peak without waiting, and leaves 14
 * slots that post-answer work can never take, above the measured pre-answer peak.
 */
export const SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT = 6

/**
 * The longest a post-answer call waits for its slots (#2170). Work after the
 * answer has 12 s (CONTINUATION_WINDOW_MS); the main wait of 15 s would hold a
 * shed write past it, cut off with nothing known. At 3 s, three attempts (the
 * engine's default) plus their 1.5 s of backoff end at 10.5 s, so the shed write
 * fails inside the window, as unknown, its at-risk record kept (written at 2 s,
 * AT_RISK_AFTER_MS, which this wait exceeds) for the read-back.
 */
export const SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS = 3_000

/** The post-answer wait: the constant above, or less when the operator set the main wait lower. */
export function salesforcePostAnswerBulkheadWaitMs(env: Env): number {
  return Math.min(salesforceBulkheadWaitMs(env), SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS)
}

/**
 * The key the Main Flow collections post takes as well, before the answer (#2847).
 * The post (`POST /services/apexrest/credit-collections`, #2832) runs in
 * `parallel_1` beside `trades_request`, the call the lead's answer waits on, for
 * every lead on the trades present route. Like the post-answer share it is taken
 * first and a main slot second, so the collections post can hold at most its
 * share of the main cap and never holds a main slot while waiting on its share.
 * It is recognised by the endpoint it calls (`isCreditCollectionsPost`).
 */
export const SALESFORCE_COLLECTIONS_BULKHEAD_KEY = 'salesforce-collections'

/**
 * How many of the main cap's slots collections posts may hold at once (#2847).
 *
 * Collections is about 3,250 calls a day (as many as `trades_request`: 9,771
 * attempts in the 3 days to 2026-10-15) against 142,000 to 191,000 Salesforce
 * steps, about 2%, so its proportional part of the 20 slots is under half of one.
 * Each call is one attempt of at most 4.5 s. By Little's law, with the whole
 * day's calls packed into 8 hours (a pessimistic spread) and every one running
 * its full 4.5 s, about 0.5 are in flight on average; at the trades call's 2 s
 * median, about 0.23. The endpoint has never been called, so these are estimates,
 * not measurements. At 0.23 in flight a call finds three already running about
 * 0.2% of the time (Poisson), so three sheds almost nothing on an ordinary day,
 * where two would make about 2% of calls wait and some of those shed. Three is
 * at most 15% of the main cap: with the post-answer share (6) full as well, 11
 * of the 20 slots stay out of both shares' reach. The measured peak of
 * pre-answer calls is about 13 (the 20 of 20 on 2026-10-11,
 * docs/salesforce-post-answer-write-contract.md), so on a day like that the cap
 * alone does not keep every slot the money path wants; the short wait below
 * does the rest, by shedding the collections post first.
 */
export const SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT = 3

/**
 * The longest a collections post waits for its slots (#2847). Its step has one
 * attempt of 4.5 s (COLLECTIONS_APEX_TIMEOUT_MS), and the wait is inside it.
 * At 400 ms a call granted at the very end of its wait still has 4.1 s, above
 * the trades call's measured p99 (4,001 ms), so it does not take a main slot it
 * then cannot use before its step timeout cuts it off (the token read and the
 * bulkhead object's own round trip are inside the attempt too, so this is the
 * most the wait can be, not a margin). It polls three times (at 0, 250 and
 * 400 ms). A shed ends at about 0.4 s, far inside the attempt, and the slot
 * still ends within its 5 s (500 ms body step and the 4.5 s call), so the
 * answer's worst case does not grow. On a full main bulkhead
 * the trades call waits 15 s and the collections post gives up after 0.4 s, so on
 * a slowdown day the money path sheds collections first. A shed fails the step
 * like any shed; the slot's `on_failure: 'continue'` mark turns it into the run's
 * degraded alert, never a failed run.
 */
export const SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS = 400

/** The collections wait: the constant above, or less when the operator set the main wait lower. */
export function salesforceCollectionsBulkheadWaitMs(env: Env): number {
  return Math.min(salesforceBulkheadWaitMs(env), SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS)
}

/**
 * A share of the main cap, held below it so the calls outside the share find one
 * slot at least whenever the main cap is 2 or more. A cap of 1 has nothing to
 * split: the share is then that one slot too, rather than 0, which would shed
 * every call that takes the share.
 */
function shareOf(limit: number, mainLimit: number): number {
  return Math.max(1, Math.min(limit, mainLimit - 1))
}

/**
 * The bulkheads a Salesforce call takes, in the order it takes them, and how long
 * it may wait for them all. `afterAnswer` is the walk's own fact (`ctx.afterAnswer`),
 * the one the at-risk watch reads, never a second test of it. `collectionsPost` is
 * `isCreditCollectionsPost` of the step's config (#2847). A call with a share
 * takes it first, so it never holds a main slot while waiting on its share.
 * After the answer the post-answer share governs every call, a collections post
 * included: it already keeps the call off the slots an answer waits on, and its
 * wait is the one sized for the 12 s window. No binding, no bulkhead.
 */
export function salesforceBulkheads(env: Env, afterAnswer: boolean, collectionsPost = false): { gates: BulkheadClient[]; waitMs: number } {
  if (!env.SALESFORCE_BULKHEAD) return { gates: [], waitMs: 0 }
  const mainLimit = salesforceBulkheadLimit(env)
  const main = new BulkheadClient(env, SALESFORCE_BULKHEAD_KEY, mainLimit)
  if (afterAnswer) {
    return {
      gates: [new BulkheadClient(env, SALESFORCE_POST_ANSWER_BULKHEAD_KEY, shareOf(SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, mainLimit)), main],
      waitMs: salesforcePostAnswerBulkheadWaitMs(env),
    }
  }
  if (collectionsPost) {
    return {
      gates: [new BulkheadClient(env, SALESFORCE_COLLECTIONS_BULKHEAD_KEY, shareOf(SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT, mainLimit)), main],
      waitMs: salesforceCollectionsBulkheadWaitMs(env),
    }
  }
  return { gates: [main], waitMs: salesforceBulkheadWaitMs(env) }
}

export interface AcquireWaitOptions {
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
  signal?: AbortSignal
}

/** What `acquireSlots` got. */
export interface HeldSlots {
  allowed: boolean
  /** The key that refused, with its count, when not allowed. */
  refusedBy?: { key: string; inflight: number; limit: number }
  /** The last grant, for the waited log line. */
  granted?: { key: string; inflight: number; limit: number }
  /** Keys whose object errored, so the call went ahead without their slot. */
  failedOpen: { key: string; error: string }[]
  /** Hands back every slot held. Never throws. */
  release(): Promise<void>
}

/**
 * Takes a slot of each key in turn, within ONE wait budget shared by them all.
 *
 * A key refusing past the budget hands back the slots already taken and refuses
 * the call. A key whose Durable Object errors is passed over and named in
 * `failedOpen`, the same for every key: a bulkhead outage must not block
 * Salesforce traffic (ADR 0005), and the caller says which key failed open.
 */
export async function acquireSlots(gates: BulkheadClient[], maxWaitMs: number, opts: AcquireWaitOptions = {}): Promise<HeldSlots> {
  const clock = opts.clock ?? Date.now
  const deadline = clock() + maxWaitMs
  const held: { gate: BulkheadClient; token: string }[] = []
  const failedOpen: HeldSlots['failedOpen'] = []
  const release = async () => {
    await Promise.all(held.splice(0).map(({ gate, token }) => gate.release(token).catch(() => {})))
  }
  let granted: HeldSlots['granted']
  for (const gate of gates) {
    let result: AcquireResult
    try {
      result = await gate.acquireWithWait(Math.max(0, deadline - clock()), opts)
    } catch (e) {
      failedOpen.push({ key: gate.name, error: formatErr(e) })
      continue
    }
    if (!result.allowed) {
      await release()
      return { allowed: false, refusedBy: { key: gate.name, inflight: result.inflight, limit: result.limit }, failedOpen, release }
    }
    if (result.token) held.push({ gate, token: result.token })
    granted = { key: gate.name, inflight: result.inflight, limit: result.limit }
  }
  return { allowed: true, granted, failedOpen, release }
}

export class BulkheadClient {
  private stub: DurableObjectStub
  readonly name: string
  readonly limit: number

  constructor(env: Env, name: string, limit: number) {
    const id = env.SALESFORCE_BULKHEAD.idFromName(`bulkhead-${name}`)
    this.stub = env.SALESFORCE_BULKHEAD.get(id)
    this.name = name
    this.limit = limit
  }

  async acquire(): Promise<AcquireResult> {
    const res = await this.stub.fetch('http://do/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: this.limit }),
    })
    return res.json<AcquireResult>()
  }

  // Burst-tolerant acquire: at capacity, poll for a freed slot until the wait
  // budget runs out or the caller's abort signal fires, then hand back the last
  // refusal so the caller sheds. Bursts clear in seconds; a lead that lands in
  // one waits briefly instead of dying (the old one-shot acquire killed it
  // instantly even though the request had never touched the dependency).
  async acquireWithWait(maxWaitMs: number, opts: AcquireWaitOptions = {}): Promise<AcquireResult> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const clock = opts.clock ?? Date.now
    // Clamp the poll below the budget so a small budget still gets >1 attempt.
    const pollMs = Math.max(10, Math.min(POLL_MS, maxWaitMs))
    const deadline = clock() + maxWaitMs

    let result = await this.acquire()
    while (!result.allowed && clock() < deadline && !opts.signal?.aborted) {
      await sleep(Math.min(pollMs, Math.max(1, deadline - clock())))
      if (opts.signal?.aborted) break
      result = await this.acquire()
    }
    return result
  }

  async release(token: string): Promise<void> {
    await this.stub.fetch('http://do/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  }

  async status(): Promise<{ inflight: number; limit: number }> {
    const res = await this.stub.fetch('http://do/status')
    return res.json()
  }
}
