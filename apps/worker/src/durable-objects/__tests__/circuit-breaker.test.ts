/**
 * CircuitBreakerObject — PRD Section 2.5.2
 *
 * Tests: closed → trips to open → half-open after cooldown → recovery → closed.
 * Also: sliding error window, probe serialization, exponential backoff, manual reset.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { CircuitBreakerObject } from '../circuit-breaker'
import type { CheckResult } from '../circuit-breaker'

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

function makeDO(initial?: unknown): CircuitBreakerObject {
  return new CircuitBreakerObject(makeDOState(initial))
}

function req(path: string, body?: unknown): Request {
  return new Request(`http://do${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function check(do_: CircuitBreakerObject): Promise<CheckResult> {
  const res = await do_.fetch(req('/check'))
  return res.json<CheckResult>()
}

async function recordError(
  do_: CircuitBreakerObject,
  config: { error_threshold?: number; window_seconds?: number; cooldown_seconds?: number } = {}
): Promise<{ ok: boolean; state: string; tripped: boolean }> {
  const res = await do_.fetch(req('/record-error', config))
  return res.json()
}

async function recordSuccess(do_: CircuitBreakerObject): Promise<{ ok: boolean; state: string }> {
  const res = await do_.fetch(req('/record-success'))
  return res.json()
}

async function releaseProbe(do_: CircuitBreakerObject): Promise<{ ok: boolean; state: string }> {
  const res = await do_.fetch(req('/release-probe'))
  return res.json()
}

async function status(do_: CircuitBreakerObject) {
  const res = await do_.fetch(req('/status'))
  return res.json<{ state: string; error_count_in_window: number }>()
}

// Trip the breaker by recording `threshold` errors within the window
async function tripBreaker(
  do_: CircuitBreakerObject,
  threshold = 3,
  windowSeconds = 60
): Promise<void> {
  for (let i = 0; i < threshold; i++) {
    await recordError(do_, { error_threshold: threshold, window_seconds: windowSeconds, cooldown_seconds: 60 })
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CircuitBreakerObject', () => {
  afterEach(() => vi.useRealTimers())

  describe('initial state (closed)', () => {
    it('allows requests when circuit is closed', async () => {
      const result = await check(makeDO())
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('stays closed while error count is below threshold', async () => {
      const do_ = makeDO()
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      const result = await check(do_)
      expect(result.state).toBe('closed')
      expect(result.allowed).toBe(true)
    })
  })

  describe('tripping to open', () => {
    it('opens when errors reach the threshold', async () => {
      const do_ = makeDO()
      await recordError(do_, { error_threshold: 3, window_seconds: 60 })
      const before = await recordError(do_, { error_threshold: 3, window_seconds: 60 })
      expect(before.tripped).toBe(false)
      const trip = await recordError(do_, { error_threshold: 3, window_seconds: 60 })
      expect(trip.tripped).toBe(true)
      expect(trip.state).toBe('open')
    })

    it('rejects requests when open', async () => {
      const do_ = makeDO()
      await tripBreaker(do_)
      const result = await check(do_)
      expect(result.allowed).toBe(false)
      expect(result.state).toBe('open')
      expect(result.reason).toBe('circuit_open')
    })

    it('includes opens_at in the response when open', async () => {
      const do_ = makeDO()
      await tripBreaker(do_)
      const result = await check(do_)
      expect(result.opens_at).toBeTypeOf('number')
      expect(result.opens_at).toBeGreaterThan(Date.now())
    })
  })

  describe('sliding error window', () => {
    it('does not trip on errors outside the window', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()

      // Record 2 errors at T=0 (threshold=3, window=10s)
      await recordError(do_, { error_threshold: 3, window_seconds: 10 })
      await recordError(do_, { error_threshold: 3, window_seconds: 10 })

      // Advance past the window
      vi.advanceTimersByTime(11_000)

      // Record 2 more — old ones fell out of window
      await recordError(do_, { error_threshold: 3, window_seconds: 10 })
      const result = await recordError(do_, { error_threshold: 3, window_seconds: 10 })

      // Only 2 active errors; threshold=3 — still closed
      expect(result.tripped).toBe(false)
      expect(result.state).toBe('closed')
    })
  })

  describe('cooldown and half-open transition', () => {
    it('transitions to half_open after cooldown elapses', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)  // cooldown=60s

      expect((await check(do_)).allowed).toBe(false)

      vi.advanceTimersByTime(61_000)
      const result = await check(do_)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('half_open')
    })

    it('blocks concurrent probes while one is already in flight', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)

      // First check → probe allowed
      const probe1 = await check(do_)
      expect(probe1.allowed).toBe(true)

      // Second check while probe in flight → blocked
      const probe2 = await check(do_)
      expect(probe2.allowed).toBe(false)
      expect(probe2.reason).toBe('probe_in_flight')
    })

    it('reclaims the probe once its lease expires (stranded probe is not permanent)', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)

      // Claim the probe but never report back (simulates a crash / lost call).
      const probe1 = await check(do_)
      expect(probe1.allowed).toBe(true)

      // Within the lease, still blocked.
      vi.advanceTimersByTime(59_000)
      expect((await check(do_)).reason).toBe('probe_in_flight')

      // Past the 60s lease, the next lead reclaims a fresh probe.
      vi.advanceTimersByTime(2_000)
      const probe2 = await check(do_)
      expect(probe2.allowed).toBe(true)
      expect(probe2.state).toBe('half_open')
    })
  })

  describe('release-probe', () => {
    it('releases a half-open probe so the next lead can claim it', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)

      await check(do_)  // claim the probe
      // Without releasing, the next check is blocked…
      expect((await check(do_)).reason).toBe('probe_in_flight')

      // …release it (partner was never called — cap/dedup skip)…
      const released = await releaseProbe(do_)
      expect(released.state).toBe('half_open')

      // …and the next lead immediately gets a fresh probe.
      const next = await check(do_)
      expect(next.allowed).toBe(true)
      expect(next.state).toBe('half_open')
    })

    it('does not record success — the circuit stays half_open, it does not close', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)
      await check(do_)

      await releaseProbe(do_)
      expect((await status(do_)).state).toBe('half_open')
    })

    it('is a no-op when the circuit is closed', async () => {
      const do_ = makeDO()
      const res = await releaseProbe(do_)
      expect(res.state).toBe('closed')
      expect((await check(do_)).allowed).toBe(true)
    })
  })

  describe('half_open → closed (recovery)', () => {
    it('closes the circuit when the probe succeeds', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)
      await check(do_)           // enter half_open

      const result = await recordSuccess(do_)
      expect(result.state).toBe('closed')

      const check2 = await check(do_)
      expect(check2.allowed).toBe(true)
      expect(check2.state).toBe('closed')
    })

    it('allows requests normally after recovery', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)
      await check(do_)
      await recordSuccess(do_)

      for (let i = 0; i < 5; i++) {
        const result = await check(do_)
        expect(result.allowed).toBe(true)
      }
    })
  })

  describe('half_open → open (probe failure with backoff)', () => {
    it('reopens when the probe fails', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)
      await check(do_)           // enter half_open

      const result = await recordError(do_)
      expect(result.state).toBe('open')
      expect(result.tripped).toBe(true)
    })

    it('applies exponential backoff: second cooldown is 1.5x longer', async () => {
      vi.useFakeTimers()
      const do_ = makeDO()

      // First trip: open, cooldown=60s
      await tripBreaker(do_, 3, 60)
      vi.advanceTimersByTime(61_000)
      await check(do_)            // enter half_open
      await recordError(do_)      // fail probe → reopen, consecutive_cooldowns=1
                                  // new cooldown = 60 * 1.5^1 = 90s

      // 61s later: still open (< 90s)
      vi.advanceTimersByTime(61_000)
      const stillOpen = await check(do_)
      expect(stillOpen.allowed).toBe(false)

      // Advance remaining 30s to pass 90s total
      vi.advanceTimersByTime(30_000)
      const halfOpen2 = await check(do_)
      expect(halfOpen2.allowed).toBe(true)
      expect(halfOpen2.state).toBe('half_open')
    })
  })

  describe('record-success in closed state', () => {
    it('is a no-op when already closed', async () => {
      const do_ = makeDO()
      const result = await recordSuccess(do_)
      expect(result.state).toBe('closed')
    })
  })

  describe('manual reset', () => {
    it('resets an open circuit to closed', async () => {
      const do_ = makeDO()
      await tripBreaker(do_)
      expect((await check(do_)).allowed).toBe(false)

      await do_.fetch(req('/reset'))
      const result = await check(do_)
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
    })

    it('clears error timestamps on reset', async () => {
      const do_ = makeDO()
      await recordError(do_, { error_threshold: 5 })
      await recordError(do_, { error_threshold: 5 })
      await do_.fetch(req('/reset'))
      const s = await status(do_)
      expect(s.error_count_in_window).toBe(0)
    })
  })

  describe('status endpoint', () => {
    it('returns current state and error count', async () => {
      const do_ = makeDO()
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      await recordError(do_, { error_threshold: 5, window_seconds: 60 })
      const s = await status(do_)
      expect(s.state).toBe('closed')
      expect(s.error_count_in_window).toBe(2)
    })
  })

  describe('unknown path', () => {
    it('returns 404 for an unrecognised route', async () => {
      const res = await makeDO().fetch(new Request('http://do/bogus'))
      expect(res.status).toBe(404)
    })
  })
})
