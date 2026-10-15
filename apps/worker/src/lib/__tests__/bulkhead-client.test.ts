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
import {
  BulkheadClient,
  salesforceBulkheadWaitMs,
  salesforcePostAnswerBulkheadWaitMs,
  salesforceBulkheads,
  acquireSlots,
  SALESFORCE_BULKHEAD_KEY,
  SALESFORCE_POST_ANSWER_BULKHEAD_KEY,
  SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT,
  SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS,
} from '../bulkhead-client'
import { CONTINUATION_WINDOW_MS } from '../post-response-budget'
import { AT_RISK_AFTER_MS } from '../../engine/at-risk-writes'
import { fakeBulkheads } from '../../__tests__/helpers/fake-bulkheads'
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

describe('salesforceBulkheadWaitMs', () => {
  // A transient Salesforce slowdown holds the shared 20-slot pool for several
  // seconds; the 2026-07-22 incident dropped 17 leads that gave up after 5s even
  // though the blip cleared inside a minute. The default budget is 15s so a lead
  // rides out a short slowdown instead of shedding. A waiting request never
  // touches Salesforce, and the 30s step timeout still bounds it.
  it('defaults to 15000ms when unset', () => {
    expect(salesforceBulkheadWaitMs({} as Env)).toBe(15_000)
  })

  it('honors a numeric env override', () => {
    expect(salesforceBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: '8000' } as unknown as Env)).toBe(8000)
  })

  it('allows 0 to shed instantly', () => {
    expect(salesforceBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: '0' } as unknown as Env)).toBe(0)
  })

  it('falls back to the default on a non-numeric value', () => {
    expect(salesforceBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: 'nope' } as unknown as Env)).toBe(15_000)
  })
})

// #2170: post-answer Salesforce calls take their own share of the bulkhead.
describe('the post-answer share (#2170)', () => {
  it('waits at most SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS, and less only when the operator asked for less', () => {
    expect(salesforcePostAnswerBulkheadWaitMs({} as Env)).toBe(SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS)
    expect(salesforcePostAnswerBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: '60000' } as unknown as Env)).toBe(SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS)
    expect(salesforcePostAnswerBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: '1000' } as unknown as Env)).toBe(1000)
    expect(salesforcePostAnswerBulkheadWaitMs({ SALESFORCE_BULKHEAD_WAIT_MS: '0' } as unknown as Env)).toBe(0)
  })

  // A shed post-answer write must fail inside the window, as unknown with its
  // at-risk record kept, rather than be cut off still waiting. Three attempts is
  // the engine's default (`retries ?? 2`), with its 500 ms and 1 s backoff; the
  // token is cached on the hot path.
  it('lets a write shed on every default attempt fail inside the post-answer window', () => {
    const attempts = 3
    const backoff = 500 + 1000
    expect(attempts * SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS + backoff).toBeLessThan(CONTINUATION_WINDOW_MS)
  })

  // A write shed before the watch's 2 s would settle unknown with nothing
  // recorded, so a single attempt waits past it.
  it('waits past the at-risk threshold, so a shed write is always recorded', () => {
    expect(SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS).toBeGreaterThan(AT_RISK_AFTER_MS)
  })

  it('keeps at least one main slot out of the share whatever the main limit is set to', () => {
    const fake = fakeBulkheads()
    const env = { SALESFORCE_BULKHEAD: fake.namespace } as unknown as Env
    const [post, main] = salesforceBulkheads(env, true).gates
    expect([post.name, post.limit, main.name, main.limit]).toEqual([SALESFORCE_POST_ANSWER_BULKHEAD_KEY, SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, SALESFORCE_BULKHEAD_KEY, 20])
    const small = salesforceBulkheads({ ...env, SALESFORCE_BULKHEAD_LIMIT: '4' } as unknown as Env, true).gates
    expect(small.map((g) => g.limit)).toEqual([3, 4])
    expect(salesforceBulkheads({ ...env, SALESFORCE_BULKHEAD_LIMIT: '1' } as unknown as Env, true).gates.map((g) => g.limit)).toEqual([1, 1])
  })

  it('pre-answer calls keep the one salesforce key and its limit', () => {
    const fake = fakeBulkheads()
    const gates = salesforceBulkheads({ SALESFORCE_BULKHEAD: fake.namespace } as unknown as Env, false).gates
    expect(gates.map((g) => [g.name, g.limit])).toEqual([[SALESFORCE_BULKHEAD_KEY, 20]])
    expect(salesforceBulkheads({} as Env, true).gates).toEqual([])
  })
})

describe('acquireSlots', () => {
  const virtualTime = () => {
    let now = 0
    return { clock: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve() } }
  }

  it('spends one wait budget across the keys, not one per key, and hands back what it held', async () => {
    // The share is full until 2 s in; the main bulkhead stays full throughout.
    const fake = fakeBulkheads({ seed: { [SALESFORCE_POST_ANSWER_BULKHEAD_KEY]: SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, [SALESFORCE_BULKHEAD_KEY]: 20 } })
    const env = { SALESFORCE_BULKHEAD: fake.namespace } as unknown as Env
    let now = 0
    let freed = false
    const sleep = async (ms: number) => {
      now += ms
      if (now >= 2000 && !freed) {
        freed = true
        await fake.namespace.get(fake.namespace.idFromName(`bulkhead-${SALESFORCE_POST_ANSWER_BULKHEAD_KEY}`))
          .fetch('http://do/release', { method: 'POST', body: JSON.stringify({ token: `seed-${SALESFORCE_POST_ANSWER_BULKHEAD_KEY}-0` }) })
      }
    }
    const held = await acquireSlots(salesforceBulkheads(env, true).gates, 3000, { sleep, clock: () => now })
    expect(held.allowed).toBe(false)
    expect(held.refusedBy).toEqual({ key: SALESFORCE_BULKHEAD_KEY, inflight: 20, limit: 20 })
    // The main wait got what the share wait left, so the whole wait ends at 3 s.
    expect(now).toBe(3000)
    // The share slot it got at 2 s is handed back, leaving the share as it found it.
    expect(fake.inflight(SALESFORCE_POST_ANSWER_BULKHEAD_KEY)).toBe(SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT - 1)
  })

  it('fails open on a key whose object errors, names it, and still takes the other', async () => {
    const fake = fakeBulkheads({ broken: [SALESFORCE_POST_ANSWER_BULKHEAD_KEY] })
    const env = { SALESFORCE_BULKHEAD: fake.namespace } as unknown as Env
    const held = await acquireSlots(salesforceBulkheads(env, true).gates, 0, virtualTime())
    expect(held.allowed).toBe(true)
    expect(held.failedOpen).toEqual([{ key: SALESFORCE_POST_ANSWER_BULKHEAD_KEY, error: 'Durable Object reset because its code was updated.' }])
    expect(fake.inflight(SALESFORCE_BULKHEAD_KEY)).toBe(1)
    await held.release()
    expect(fake.inflight(SALESFORCE_BULKHEAD_KEY)).toBe(0)
  })
})
