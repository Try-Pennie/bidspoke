// Client for the BulkheadObject inflight-concurrency limiter (ADR 0005 / #312).
// One DO instance per dependency name (e.g. "salesforce"). `acquire` before the
// dependency call, `release` in a finally. The limit is passed per acquire so it
// stays env-configurable without redeploying the DO.

import type { AcquireResult } from '../durable-objects/bulkhead'
import type { Env } from '../index'

export type { AcquireResult }

const DEFAULT_LIMIT = 20

/** Resolve the configured Salesforce inflight cap (env override, sane default). */
export function salesforceBulkheadLimit(env: Env): number {
  const raw = env.SALESFORCE_BULKHEAD_LIMIT
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT
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
