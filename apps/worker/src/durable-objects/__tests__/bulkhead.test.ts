/**
 * BulkheadObject (#312, ADR 0005) — a lease-based inflight-concurrency limiter
 * for a shared non-scaling dependency (Salesforce). Caps simultaneous in-flight
 * calls below the dependency's governor and fails fast when exhausted, with
 * leases that auto-expire so a crashed caller can't permanently hold a slot.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { BulkheadObject, type AcquireResult } from '../bulkhead'

function makeDOState(initial?: unknown): DurableObjectState {
  const store = new Map<string, unknown>()
  if (initial !== undefined) store.set('data', initial)
  return {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { store.set(key, value) },
    },
  } as unknown as DurableObjectState
}

function makeDO(initial?: unknown): BulkheadObject {
  return new BulkheadObject(makeDOState(initial))
}

function req(path: string, body?: unknown): Request {
  return new Request(`http://do${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function acquire(b: BulkheadObject, limit?: number): Promise<AcquireResult> {
  const res = await b.fetch(req('/acquire', limit !== undefined ? { limit } : undefined))
  return res.json<AcquireResult>()
}
async function release(b: BulkheadObject, token: string): Promise<{ released: boolean; inflight: number }> {
  const res = await b.fetch(req('/release', { token }))
  return res.json()
}
async function status(b: BulkheadObject): Promise<{ inflight: number }> {
  const res = await b.fetch(req('/status'))
  return res.json()
}

afterEach(() => vi.useRealTimers())

describe('BulkheadObject', () => {
  it('grants a lease while under the limit and increments inflight', async () => {
    const b = makeDO()
    const a1 = await acquire(b, 3)
    const a2 = await acquire(b, 3)
    expect(a1.allowed).toBe(true)
    expect(a1.token).toBeTruthy()
    expect(a2.allowed).toBe(true)
    expect(a2.inflight).toBe(2)
    expect(a2.token).not.toBe(a1.token)
  })

  it('refuses once the limit is reached (fail fast)', async () => {
    const b = makeDO()
    await acquire(b, 2)
    await acquire(b, 2)
    const a3 = await acquire(b, 2)
    expect(a3.allowed).toBe(false)
    expect(a3.inflight).toBe(2)
    expect(a3.limit).toBe(2)
    expect(a3.token).toBeUndefined()
  })

  it('release frees a slot so the next acquire is granted', async () => {
    const b = makeDO()
    const a1 = await acquire(b, 1)
    expect((await acquire(b, 1)).allowed).toBe(false) // at cap
    const r = await release(b, a1.token!)
    expect(r.released).toBe(true)
    expect(r.inflight).toBe(0)
    expect((await acquire(b, 1)).allowed).toBe(true) // slot freed
  })

  it('releasing an unknown token is a no-op', async () => {
    const b = makeDO()
    await acquire(b, 2)
    const r = await release(b, 'not-a-real-token')
    expect(r.released).toBe(false)
    expect(r.inflight).toBe(1)
  })

  it('reclaims an expired lease so a crashed caller cannot hold a slot forever', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const b = makeDO()
    await acquire(b, 1) // hold the only slot, never release (simulate a crash)
    expect((await acquire(b, 1)).allowed).toBe(false)
    // Advance past the lease window — the stale lease is reclaimed on next acquire.
    vi.setSystemTime(60_000)
    const a = await acquire(b, 1)
    expect(a.allowed).toBe(true)
    expect(a.inflight).toBe(1)
  })

  it('status reports the current (pruned) inflight count', async () => {
    const b = makeDO()
    await acquire(b, 5)
    await acquire(b, 5)
    expect((await status(b)).inflight).toBe(2)
  })
})
