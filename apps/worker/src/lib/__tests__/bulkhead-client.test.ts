/**
 * BulkheadClient.acquireWithWait — burst-tolerant acquire (follow-up to #312).
 *
 * The one-shot acquire() shed leads instantly during 20-60s traffic bursts even
 * though slots freed within seconds (16 live leads dropped 2026-07-01..07-03).
 * A shed request never touched Salesforce, so briefly waiting and re-asking is
 * safe for SF; only the instant kill was wrong. acquireWithWait polls until a
 * slot frees, the wait budget runs out, or the step's abort signal fires.
 */
import { describe, it, expect, vi } from 'vitest'
import { BulkheadClient } from '../bulkhead-client'
import type { Env } from '../../index'

// Fake DO namespace whose acquire responses come from a queue; refusals repeat
// the last entry once the queue drains (a saturated bulkhead stays saturated).
function makeEnv(results: Array<{ allowed: boolean }>) {
  const acquireCalls: number[] = []
  const stub = {
    fetch: vi.fn((url: string) => {
      const path = new URL(url).pathname
      if (path === '/acquire') {
        acquireCalls.push(Date.now())
        const next = results.length > 1 ? results.shift()! : results[0]
        const body = next.allowed
          ? { allowed: true, token: 't-1', inflight: 1, limit: 20 }
          : { allowed: false, inflight: 20, limit: 20 }
        return Promise.resolve(new Response(JSON.stringify(body)))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })))
    }),
  }
  const env = {
    SALESFORCE_BULKHEAD: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(stub),
    },
  } as unknown as Env
  return { env, acquireCalls }
}

describe('BulkheadClient.acquireWithWait', () => {
  it('returns immediately when a slot is free (no sleeping)', async () => {
    const { env } = makeEnv([{ allowed: true }])
    const sleeps: number[] = []
    const client = new BulkheadClient(env, 'salesforce', 20)
    const result = await client.acquireWithWait(5000, {
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    })
    expect(result.allowed).toBe(true)
    expect(result.token).toBeTruthy()
    expect(sleeps).toHaveLength(0)
  })

  it('polls while at capacity and succeeds once a slot frees', async () => {
    const { env, acquireCalls } = makeEnv([
      { allowed: false },
      { allowed: false },
      { allowed: true },
    ])
    const sleeps: number[] = []
    const client = new BulkheadClient(env, 'salesforce', 20)
    const result = await client.acquireWithWait(5000, {
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    })
    expect(result.allowed).toBe(true)
    expect(acquireCalls.length).toBe(3)
    expect(sleeps.length).toBe(2)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
  })

  it('gives up (allowed=false) once the wait budget is exhausted', async () => {
    const { env } = makeEnv([{ allowed: false }])
    // Virtual clock: each sleep advances time so the deadline is reached.
    let now = 0
    const client = new BulkheadClient(env, 'salesforce', 20)
    const result = await client.acquireWithWait(1000, {
      sleep: (ms) => { now += ms; return Promise.resolve() },
      clock: () => now,
    })
    expect(result.allowed).toBe(false)
    expect(result.inflight).toBe(20)
  })

  it('a zero wait budget behaves like the old one-shot acquire', async () => {
    const { env, acquireCalls } = makeEnv([{ allowed: false }])
    const sleeps: number[] = []
    const client = new BulkheadClient(env, 'salesforce', 20)
    const result = await client.acquireWithWait(0, {
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    })
    expect(result.allowed).toBe(false)
    expect(acquireCalls.length).toBe(1)
    expect(sleeps).toHaveLength(0)
  })

  it('stops waiting when the abort signal fires (step timeout must win)', async () => {
    const { env, acquireCalls } = makeEnv([{ allowed: false }])
    const controller = new AbortController()
    const client = new BulkheadClient(env, 'salesforce', 20)
    const result = await client.acquireWithWait(60_000, {
      sleep: () => { controller.abort(); return Promise.resolve() },
      signal: controller.signal,
    })
    expect(result.allowed).toBe(false)
    expect(acquireCalls.length).toBe(1) // no re-poll after abort
  })
})
