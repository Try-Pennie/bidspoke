/**
 * DailyCapObject — PRD Section 2.5.1
 *
 * Tests: cap enforcement, unlimited cap (null), reset, midnight rollover semantics.
 * The DO is tested directly — no network layer required.
 */
import { describe, it, expect } from 'vitest'
import { DailyCapObject } from '../daily-cap'
import type { CapCheckResult } from '../daily-cap'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeDO(initial?: unknown): DailyCapObject {
  return new DailyCapObject(makeDOState(initial))
}

function req(path: string, body?: unknown): Request {
  return new Request(`http://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function checkAndIncrement(do_: DailyCapObject, cap: number | null): Promise<CapCheckResult> {
  const res = await do_.fetch(req('/check-and-increment', { cap }))
  return res.json<CapCheckResult>()
}

async function getCount(do_: DailyCapObject): Promise<number> {
  const res = await do_.fetch(req('/get-count'))
  const body = await res.json<{ count: number }>()
  return body.count
}

async function reset(do_: DailyCapObject): Promise<void> {
  await do_.fetch(req('/reset'))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DailyCapObject', () => {
  describe('check-and-increment', () => {
    it('allows the first request when count is zero', async () => {
      const result = await checkAndIncrement(makeDO(), 100)
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(1)
      expect(result.cap).toBe(100)
    })

    it('increments count on each allowed request', async () => {
      const do_ = makeDO()
      await checkAndIncrement(do_, 100)
      await checkAndIncrement(do_, 100)
      const result = await checkAndIncrement(do_, 100)
      expect(result.count).toBe(3)
    })

    it('allows the last request that brings count to cap', async () => {
      const do_ = makeDO({ count: 9 })
      const result = await checkAndIncrement(do_, 10)
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(10)
    })

    it('rejects when count equals cap', async () => {
      const do_ = makeDO({ count: 10 })
      const result = await checkAndIncrement(do_, 10)
      expect(result.allowed).toBe(false)
      expect(result.count).toBe(10)  // count does NOT increment when rejected
    })

    it('rejects when count exceeds cap (should not happen in normal flow, but defensive)', async () => {
      const do_ = makeDO({ count: 100 })
      const result = await checkAndIncrement(do_, 10)
      expect(result.allowed).toBe(false)
    })

    it('always allows when cap is null (unlimited)', async () => {
      const do_ = makeDO({ count: 9999 })
      const result = await checkAndIncrement(do_, null)
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(10000)
    })
  })

  describe('get-count', () => {
    it('returns current count', async () => {
      const do_ = makeDO({ count: 42 })
      expect(await getCount(do_)).toBe(42)
    })

    it('returns 0 on a fresh DO with no stored state', async () => {
      expect(await getCount(makeDO())).toBe(0)
    })
  })

  describe('reset', () => {
    it('resets count to 0 from a non-zero value', async () => {
      const do_ = makeDO({ count: 99 })
      await reset(do_)
      expect(await getCount(do_)).toBe(0)
    })

    it('allows requests again after reset', async () => {
      const do_ = makeDO({ count: 100 })
      // Confirm rejected before reset
      const before = await checkAndIncrement(do_, 100)
      expect(before.allowed).toBe(false)
      // Reset, then confirm allowed
      await reset(do_)
      const after = await checkAndIncrement(do_, 100)
      expect(after.allowed).toBe(true)
      expect(after.count).toBe(1)
    })
  })

  describe('midnight rollover semantics', () => {
    // The DO identifier is cap-{slug}-{YYYY-MM-DD}. At midnight UTC the engine
    // uses a new key, which creates a brand-new DO instance. This test verifies
    // that a fresh instance has count=0 — the rollover comes for free via key rotation.
    it('starts at count 0 on a new instance (simulates midnight rollover)', async () => {
      const freshDO = makeDO()  // no stored state = new key on new day
      const result = await checkAndIncrement(freshDO, 100)
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(1)
    })

    it('accumulates count within the same day (same DO instance)', async () => {
      const do_ = makeDO()
      for (let i = 0; i < 50; i++) {
        await checkAndIncrement(do_, 100)
      }
      expect(await getCount(do_)).toBe(50)
    })
  })

  describe('unknown path', () => {
    it('returns 404 for an unrecognised route', async () => {
      const do_ = makeDO()
      const res = await do_.fetch(new Request('http://do/unknown'))
      expect(res.status).toBe(404)
    })
  })
})
