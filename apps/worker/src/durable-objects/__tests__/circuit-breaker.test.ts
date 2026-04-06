import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { CircuitBreakerObject } from '../circuit-breaker'

// In-memory DurableObjectState mock
function makeStorage() {
  const store = new Map<string, unknown>()
  return {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => { store.set(key, value) },
  }
}

function makeDO() {
  const state = { storage: makeStorage() } as unknown as DurableObjectState
  return new CircuitBreakerObject(state)
}

// Request helpers
function req(path: string, body?: unknown) {
  return new Request(`http://do${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function check(cb: CircuitBreakerObject) {
  return (await cb.fetch(req('/check'))).json<Record<string, unknown>>()
}
async function recordSuccess(cb: CircuitBreakerObject) {
  return (await cb.fetch(req('/record-success', {}))).json<Record<string, unknown>>()
}
async function recordError(cb: CircuitBreakerObject, opts: Record<string, unknown> = {}) {
  return (await cb.fetch(req('/record-error', opts))).json<Record<string, unknown>>()
}
async function status(cb: CircuitBreakerObject) {
  return (await cb.fetch(req('/status'))).json<Record<string, unknown>>()
}
async function reset(cb: CircuitBreakerObject) {
  return (await cb.fetch(req('/reset', {}))).json<Record<string, unknown>>()
}

describe('CircuitBreakerObject', () => {
  let cb: CircuitBreakerObject

  beforeEach(() => {
    cb = makeDO()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('closed state (default)', () => {
    it('allows requests and reports closed state', async () => {
      const result = await check(cb)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('stays closed below the error threshold', async () => {
      // threshold defaults to 5 — 4 errors should not trip it
      for (let i = 0; i < 4; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      const result = await check(cb)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('prunes errors outside the sliding window', async () => {
      // Record 4 errors then advance past the window (60s default)
      for (let i = 0; i < 4; i++) {
        await recordError(cb, { error_threshold: 5, window_seconds: 60 })
      }
      vi.advanceTimersByTime(61_000)
      // Record one more — the 4 old ones are pruned, only 1 remains → no trip
      await recordError(cb, { error_threshold: 5, window_seconds: 60 })
      const result = await check(cb)
      expect(result.allowed).toBe(true)
    })
  })

  describe('tripping the circuit', () => {
    it('opens after hitting the error threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      const result = await check(cb)
      expect(result.allowed).toBe(false)
      expect(result.state).toBe('open')
      expect(result.reason).toBe('circuit_open')
    })

    it('returns opens_at timestamp when open', async () => {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      const result = await check(cb)
      expect(typeof result.opens_at).toBe('number')
      expect(result.opens_at as number).toBeGreaterThan(Date.now())
    })

    it('respects a custom threshold passed via recordError', async () => {
      // threshold = 3: only 3 errors needed
      for (let i = 0; i < 3; i++) {
        await recordError(cb, { error_threshold: 3 })
      }
      const result = await check(cb)
      expect(result.allowed).toBe(false)
      expect(result.state).toBe('open')
    })

    it('rejects all requests while open (before cooldown)', async () => {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      // Multiple consecutive checks — all rejected
      for (let i = 0; i < 3; i++) {
        const result = await check(cb)
        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('circuit_open')
      }
    })
  })

  describe('open → half-open transition', () => {
    async function tripCircuit() {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5, cooldown_seconds: 300 })
      }
    }

    it('transitions to half-open after the cooldown elapses', async () => {
      await tripCircuit()
      vi.advanceTimersByTime(300_001)
      const result = await check(cb)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('half_open')
    })

    it('allows exactly one probe (second check is rejected)', async () => {
      await tripCircuit()
      vi.advanceTimersByTime(300_001)
      const first = await check(cb)
      expect(first.allowed).toBe(true)
      const second = await check(cb)
      expect(second.allowed).toBe(false)
      expect(second.reason).toBe('probe_in_flight')
    })

    it('does not transition before the cooldown elapses', async () => {
      await tripCircuit()
      vi.advanceTimersByTime(299_000)
      const result = await check(cb)
      expect(result.allowed).toBe(false)
      expect(result.state).toBe('open')
    })
  })

  describe('half-open recovery — successful probe', () => {
    async function tripAndHalfOpen() {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5, cooldown_seconds: 300 })
      }
      vi.advanceTimersByTime(300_001)
      await check(cb) // consume the probe slot
    }

    it('closes the circuit after a successful probe', async () => {
      await tripAndHalfOpen()
      await recordSuccess(cb)
      const result = await check(cb)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('resets error timestamps and consecutiveCooldowns on close', async () => {
      await tripAndHalfOpen()
      await recordSuccess(cb)
      const s = await status(cb)
      expect(s.error_count_in_window).toBe(0)
      expect(s.consecutive_cooldowns).toBe(0)
    })

    it('new errors after close start a fresh count', async () => {
      await tripAndHalfOpen()
      await recordSuccess(cb)
      // 4 errors — should not re-trip (threshold is still 5)
      for (let i = 0; i < 4; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      const result = await check(cb)
      expect(result.allowed).toBe(true)
    })
  })

  describe('half-open recovery — failed probe (backoff)', () => {
    async function tripAndHalfOpen() {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5, cooldown_seconds: 300 })
      }
      vi.advanceTimersByTime(300_001)
      await check(cb) // consume probe slot
    }

    it('reopens the circuit when probe fails', async () => {
      await tripAndHalfOpen()
      const errorResult = await recordError(cb)
      expect(errorResult.state).toBe('open')
      expect(errorResult.tripped).toBe(true)
    })

    it('increments consecutiveCooldowns on reopen', async () => {
      await tripAndHalfOpen()
      await recordError(cb)
      const s = await status(cb)
      expect(s.consecutive_cooldowns).toBe(1)
    })

    it('applies exponential backoff: second cooldown is longer than first', async () => {
      // First trip
      await tripAndHalfOpen()
      await recordError(cb) // reopen — consecutiveCooldowns = 1

      // Advance base cooldown (300s) — not enough for backoff (300 * 1.5^1 = 450s)
      vi.advanceTimersByTime(300_001)
      const beforeBackoff = await check(cb)
      expect(beforeBackoff.allowed).toBe(false) // still open

      // Advance remaining backoff
      vi.advanceTimersByTime(150_001)
      const afterBackoff = await check(cb)
      expect(afterBackoff.allowed).toBe(true)
      expect(afterBackoff.state).toBe('half_open')
    })
  })

  describe('manual reset', () => {
    it('closes the circuit from open state', async () => {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5 })
      }
      await reset(cb)
      const result = await check(cb)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('clears all error timestamps and probe state', async () => {
      for (let i = 0; i < 5; i++) {
        await recordError(cb, { error_threshold: 5, cooldown_seconds: 300 })
      }
      vi.advanceTimersByTime(300_001)
      await check(cb) // puts into half-open with probe in flight
      await reset(cb)
      const s = await status(cb)
      expect(s.error_count_in_window).toBe(0)
      expect(s.consecutive_cooldowns).toBe(0)
    })
  })

  describe('status endpoint', () => {
    it('reports current error count in window', async () => {
      await recordError(cb, { error_threshold: 5 })
      await recordError(cb, { error_threshold: 5 })
      const s = await status(cb)
      expect(s.error_count_in_window).toBe(2)
      expect(s.state).toBe('closed')
    })

    it('prunes stale errors from window in status', async () => {
      await recordError(cb, { error_threshold: 5, window_seconds: 60 })
      vi.advanceTimersByTime(61_000)
      const s = await status(cb)
      expect(s.error_count_in_window).toBe(0)
    })
  })
})
