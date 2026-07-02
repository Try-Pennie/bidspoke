/**
 * Issue #492 (AUD-062): req() had no timeout, so a hung request waited forever —
 * the UI spinner could never reach a failed state (violating the working /
 * still-alive / failed rule). req() now aborts after a per-endpoint ceiling and
 * throws a clear, retryable timeout error instead of hanging.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api } from '../api'

// A fetch that never settles on its own but rejects the moment its AbortSignal
// fires, mimicking a real hung request that the client-side timeout cancels.
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal) {
        signal.addEventListener('abort', () =>
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
        )
      }
    })
  })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('req() request timeout (#492)', () => {
  it('rejects with a timeout error when a request hangs past the default ceiling', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const p = api.workflows.list()
    p.catch(() => {}) // avoid an unhandled rejection before we advance timers
    await vi.advanceTimersByTimeAsync(31_000)
    await expect(p).rejects.toThrow(/timed out/i)
  })

  it('marks the timeout error retryable via a timedOut flag', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const p = api.workflows.list()
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(31_000)
    const err = await p.catch((e) => e)
    expect(err.timedOut).toBe(true)
  })

  it('does not abort a request that completes before the ceiling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '[]',
        json: async () => [],
      })),
    )
    const p = api.workflows.list()
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toEqual([])
  })

  it('gives long operations (test run) a longer ceiling than the default', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const p = api.workflows.test('w1', {})
    p.catch(() => {})
    // Past the 30s default but a test run must still be in flight.
    await vi.advanceTimersByTimeAsync(31_000)
    let settled = false
    p.then(() => (settled = true)).catch(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    // Past the test-run ceiling it aborts.
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(p).rejects.toThrow(/timed out/i)
  })
})
