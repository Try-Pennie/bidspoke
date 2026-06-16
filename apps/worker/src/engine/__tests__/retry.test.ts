import { describe, it, expect, vi, afterEach } from 'vitest'
import { withRetry, linkAbort } from '../retry'
import { classifyStepError } from '../error-classifier'
import { PartnerApiError } from '../partner-bid-error'
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

// ── Stats out-param ───────────────────────────────────────────────────────────

describe('withRetry — stats out-param', () => {
  it('reports 0 retries when fn succeeds on the first attempt', async () => {
    const stats = { retries: 0 }
    const fn = vi.fn().mockResolvedValue('ok')
    await withRetry(fn, { retries: 3, backoff: 'linear', timeout_ms: 5000 }, transient, stats)
    expect(stats.retries).toBe(0)
  })

  it('reports the number of retries used before a transient success', async () => {
    vi.useFakeTimers()
    const stats = { retries: 0 }
    let calls = 0
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 3) throw new Error('flaky')
      return 'recovered'
    })
    const p = withRetry(fn, { retries: 5, backoff: 'linear', timeout_ms: 60_000 }, transient, stats)
    await vi.runAllTimersAsync()
    await p
    expect(stats.retries).toBe(2) // failed twice, succeeded on the 3rd attempt
  })

  it('reports retries used even when all attempts are exhausted (throw path)', async () => {
    vi.useFakeTimers()
    const stats = { retries: 0 }
    const fn = vi.fn().mockImplementation(async () => { throw new Error('always fails') })
    const p = withRetry(fn, { retries: 2, backoff: 'linear', timeout_ms: 60_000 }, transient, stats)
    await Promise.all([vi.runAllTimersAsync(), expect(p).rejects.toThrow('always fails')])
    expect(stats.retries).toBe(2) // 1 initial + 2 retries, then gave up
  })

  it('reports 0 retries when the first error is permanent', async () => {
    const stats = { retries: 0 }
    const fn = vi.fn().mockRejectedValue(new Error('bad request'))
    await expect(
      withRetry(fn, { retries: 3, backoff: 'linear', timeout_ms: 5000 }, permanent, stats)
    ).rejects.toThrow('bad request')
    expect(stats.retries).toBe(0)
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

describe('saturation signals (2026-06-10 create_prospect incident)', () => {
  const config = { retries: 3, backoff: 'linear' as const, timeout_ms: 1000 }
  const alwaysTransient = () => 'transient' as const

  it('does not retry a transient error carrying REQUEST_LIMIT_EXCEEDED', async () => {
    const fn = vi.fn().mockRejectedValue(
      new Error('Salesforce API error (403): [{"errorCode":"REQUEST_LIMIT_EXCEEDED","message":"ConcurrentRequests (Concurrent API Requests) Limit exceeded."}]')
    )
    await expect(withRetry(fn, config, alwaysTransient)).rejects.toThrow('REQUEST_LIMIT_EXCEEDED')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry an error explicitly marked saturated', async () => {
    const err = Object.assign(new Error('partner concurrency limit'), { saturated: true })
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, config, alwaysTransient)).rejects.toThrow('partner concurrency limit')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still retries ordinary transient errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('ok')
    await expect(withRetry(fn, config, alwaysTransient)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rejects with a timeout error noting the in-flight call was canceled', async () => {
    const never = () => new Promise(() => {})
    await expect(withRetry(never, { retries: 0, backoff: 'linear', timeout_ms: 10 }, alwaysTransient))
      .rejects.toThrow(/Step timed out after 10ms \(in-flight upstream call canceled/)
  })

  // #66: the per-attempt signal must actually abort on timeout, so the executor's
  // outbound call is canceled before any retry (no double-fire).
  it('aborts the signal passed to fn when the attempt times out', async () => {
    let captured: AbortSignal | undefined
    const fn = (signal: AbortSignal) => {
      captured = signal
      return new Promise<never>(() => {}) // never settles on its own
    }
    await expect(withRetry(fn, { retries: 0, backoff: 'linear', timeout_ms: 10 }, alwaysTransient))
      .rejects.toThrow(/timed out/)
    expect(captured?.aborted).toBe(true)
  })

  it('gives each retry a fresh, un-aborted signal', async () => {
    const signals: AbortSignal[] = []
    let attempt = 0
    const fn = (signal: AbortSignal) => {
      signals.push(signal)
      attempt++
      // First attempt hangs (will time out + abort); second resolves immediately.
      return attempt === 1 ? new Promise<string>(() => {}) : Promise.resolve('ok')
    }
    await expect(
      withRetry(fn, { retries: 1, backoff: 'linear', timeout_ms: 10 }, alwaysTransient)
    ).resolves.toBe('ok')
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)   // first attempt was canceled
    expect(signals[1].aborted).toBe(false)  // retry got a fresh signal
  })
})

// #66: linkAbort connects an executor's own fetch controller to the step-level
// signal, so a step timeout cancels the in-flight outbound call.
describe('linkAbort', () => {
  it('aborts the controller when the parent signal aborts', () => {
    const parent = new AbortController()
    const child = new AbortController()
    linkAbort(child, parent.signal)
    expect(child.signal.aborted).toBe(false)
    parent.abort()
    expect(child.signal.aborted).toBe(true)
  })

  it('aborts immediately when the parent is already aborted', () => {
    const parent = new AbortController()
    parent.abort()
    const child = new AbortController()
    linkAbort(child, parent.signal)
    expect(child.signal.aborted).toBe(true)
  })

  it('is a no-op with no parent signal', () => {
    const child = new AbortController()
    linkAbort(child, undefined)
    expect(child.signal.aborted).toBe(false)
  })
})

// Issue #53: a permanent PartnerApiError must NOT be retried (re-POSTing the
// lead and burning a cap slot each time). The retry classifier must read
// PartnerApiError.errorType, not fall through to the transport default.
describe('withRetry + classifyStepError — partner errors', () => {
  const config = { retries: 2, backoff: 'linear' as const, timeout_ms: 5000 }

  it('does not retry a permanent PartnerApiError', async () => {
    const fn = vi.fn().mockRejectedValue(new PartnerApiError('Partner API returned 400', 'permanent', false))
    await expect(withRetry(fn, config, classifyStepError)).rejects.toBeInstanceOf(PartnerApiError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still retries a transient PartnerApiError', async () => {
    const fn = vi.fn().mockRejectedValue(new PartnerApiError('Partner API returned 503', 'transient', false))
    await expect(withRetry(fn, config, classifyStepError)).rejects.toBeInstanceOf(PartnerApiError)
    expect(fn).toHaveBeenCalledTimes(3) // first attempt + 2 retries
  })

  it('does not retry a business-rejection PartnerApiError (null errorType)', async () => {
    const fn = vi.fn().mockRejectedValue(new PartnerApiError('rejected', null, false))
    await expect(withRetry(fn, config, classifyStepError)).rejects.toBeInstanceOf(PartnerApiError)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
