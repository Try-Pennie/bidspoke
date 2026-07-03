// Client for the BulkheadObject inflight-concurrency limiter (ADR 0005 / #312).
// One DO instance per dependency name (e.g. "salesforce"). `acquire` before the
// dependency call, `release` in a finally. The limit is passed per acquire so it
// stays env-configurable without redeploying the DO.

import type { AcquireResult } from '../durable-objects/bulkhead'
import type { Env } from '../index'

export type { AcquireResult }

const DEFAULT_LIMIT = 20
// How long a caller will wait for a slot before shedding. Bursts observed in
// prod (2026-07-01..07-03: 16 live leads shed) cleared within seconds, so a
// short wait converts an instant lead kill into a slightly slower lead. A
// waiting request never touches the protected dependency, so waiting is safe
// for Salesforce; it only defers our own call.
const DEFAULT_WAIT_MS = 5_000
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

export interface AcquireWaitOptions {
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
  signal?: AbortSignal
}

export class BulkheadClient {
  private stub: DurableObjectStub
  private limit: number

  constructor(env: Env, name: string, limit: number) {
    const id = env.SALESFORCE_BULKHEAD.idFromName(`bulkhead-${name}`)
    this.stub = env.SALESFORCE_BULKHEAD.get(id)
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
