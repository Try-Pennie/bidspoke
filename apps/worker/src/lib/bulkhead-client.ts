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
 * and post-answer work can never hold more than its share of it. A pre-answer
 * call always finds the rest (at the default cap of 20, the other 14; at any cap
 * of 2 or more, one at least, see `salesforceBulkheads`).
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
 * The bulkheads a Salesforce call takes, in the order it takes them, and how long
 * it may wait for them all. `afterAnswer` is the walk's own fact (`ctx.afterAnswer`),
 * the one the at-risk watch reads, never a second test of it. A post-answer call
 * takes its share first, so it never holds a main slot while waiting on its share.
 * No binding, no bulkhead.
 */
export function salesforceBulkheads(env: Env, afterAnswer: boolean): { gates: BulkheadClient[]; waitMs: number } {
  if (!env.SALESFORCE_BULKHEAD) return { gates: [], waitMs: 0 }
  const mainLimit = salesforceBulkheadLimit(env)
  const main = new BulkheadClient(env, SALESFORCE_BULKHEAD_KEY, mainLimit)
  if (!afterAnswer) return { gates: [main], waitMs: salesforceBulkheadWaitMs(env) }
  // A main cap set at or below the share would let post-answer work fill it, so
  // the share is held below the main cap, leaving pre-answer calls one slot at
  // least, whenever the main cap is 2 or more. A cap of 1 has nothing to split:
  // the share is then that one slot too, rather than 0, which would shed every
  // post-answer call.
  const shareLimit = Math.max(1, Math.min(SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, mainLimit - 1))
  return {
    gates: [new BulkheadClient(env, SALESFORCE_POST_ANSWER_BULKHEAD_KEY, shareLimit), main],
    waitMs: salesforcePostAnswerBulkheadWaitMs(env),
  }
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
