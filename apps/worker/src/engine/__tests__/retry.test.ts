import { describe, it, expect, vi, afterEach } from 'vitest'
import { withRetry } from '../retry'
import type { ErrorType } from '../../types'

const permanent = (): ErrorType => 'permanent'
const transient = (): ErrorType => 'transient'

afterEach(() => {
  vi.useRealTimers()
})

// ── Basic behavior ────────────────────────────────────────────────────────────

describe('withRetry — success cases', () => {
  it('returns the result immediately when fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { retries: 3, backoff: 'linear', timeout_ms: 5000 }, transient)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })
})

// ── Permanent errors ──────────────────────────────────────────────────────────

describe('withRetry — permanent errors', () => {
  it('throws immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad request'))
    await expect(
      withRetry(fn, { retries: 3, backoff: 'linear', timeout_ms: 5000 }, permanent)
    ).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does not retry even when retries > 0', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'))
    await expect(
      withRetry(fn, { retries: 5, backoff: 'linear', timeout_ms: 5000 }, permanent)
    ).rejects.toThrow()
    expect(fn).toHaveBeenCalledOnce()
  })
})

// ── Transient errors ──────────────────────────────────────────────────────────

describe('withRetry — transient errors', () => {
  it('retries up to the configured limit and succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 3) throw new Error('flaky')
      return 'recovered'
    })
    const p = withRetry(fn, { retries: 2, backoff: 'linear', timeout_ms: 60_000 }, transient)
    await vi.runAllTimersAsync()
    expect(await p).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting all retries', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockImplementation(async () => { throw new Error('always fails') })
    const p = withRetry(fn, { retries: 2, backoff: 'linear', timeout_ms: 60_000 }, transient)
    // Attach handler and advance timers concurrently so the rejection is never "unhandled"
    await Promise.all([vi.runAllTimersAsync(), expect(p).rejects.toThrow('always fails')])
    expect(fn).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('retries=0 does not retry even transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient'))
    await expect(
      withRetry(fn, { retries: 0, backoff: 'linear', timeout_ms: 5000 }, transient)
    ).rejects.toThrow('transient')
    expect(fn).toHaveBeenCalledOnce()
  })
})

// ── Mixed permanent/transient ─────────────────────────────────────────────────

describe('withRetry — mixed classification', () => {
  it('retries transient then stops on permanent', async () => {
    vi.useFakeTimers()
    let calls = 0
    const err1 = new Error('network')
    const err2 = new Error('bad request — permanent')
    const fn = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) throw err1
      throw err2
    })
    const classify = (e: unknown): ErrorType => (e === err1 ? 'transient' : 'permanent')
    const p = withRetry(fn, { retries: 3, backoff: 'linear', timeout_ms: 60_000 }, classify)
    await Promise.all([vi.runAllTimersAsync(), expect(p).rejects.toBe(err2)])
    expect(fn).toHaveBeenCalledTimes(2) // 1 transient → retry → 1 permanent → stop
  })
})

// ── Timeout ───────────────────────────────────────────────────────────────────

describe('withRetry — timeout', () => {
  it('rejects if fn takes longer than timeout_ms', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves
    const p = withRetry(fn, { retries: 0, backoff: 'linear', timeout_ms: 100 }, transient)
    await Promise.all([vi.advanceTimersByTimeAsync(200), expect(p).rejects.toThrow('timed out')])
  })
})
