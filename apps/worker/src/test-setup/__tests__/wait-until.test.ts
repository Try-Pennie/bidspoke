/**
 * The recording ExecutionContext every worker unit test hands to the code under
 * test (#2120), and the check after each test that nothing it handed off is
 * still running.
 *
 * Work handed to waitUntil and never awaited went on running after its test,
 * and when it logged after the file's worker closed, vitest failed the whole
 * run ("Closing rpc while onUserConsoleLog was pending") with every test green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordingContext, settleAfterTest } from '../wait-until'

afterEach(() => { vi.useRealTimers() })

// Taken before any test fakes the clock.
const realSetTimeout = globalThis.setTimeout

/** A promise that settles only when the test says so. */
function gate<T = void>() {
  let open!: (v: T) => void
  let fail!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { open = res; fail = rej })
  return { promise, open, fail }
}

describe('recordingContext', () => {
  it('keeps every promise handed to waitUntil and counts the ones still running', async () => {
    const ctx = recordingContext()
    const a = gate()
    const b = gate()
    ctx.waitUntil(a.promise)
    ctx.waitUntil(b.promise)
    expect(ctx.handed).toEqual([a.promise, b.promise])
    expect(ctx.pending()).toBe(2)
    a.open()
    await a.promise
    expect(ctx.pending()).toBe(1)
    b.open()
    await ctx.settle()
    expect(ctx.pending()).toBe(0)
  })

  it('is a vi.fn, so a test can still assert how it was called', () => {
    const ctx = recordingContext()
    ctx.waitUntil(Promise.resolve())
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.waitUntil).mock.calls[0][0]).toBeInstanceOf(Promise)
  })

  it('keeps recording after vi.resetAllMocks, which restores a vi.fn to the implementation it was made with', async () => {
    const ctx = recordingContext()
    vi.resetAllMocks()
    ctx.waitUntil(gate().promise)
    expect(ctx.pending()).toBe(1)
    ctx.forget()
    expect(ctx.pending()).toBe(0)
  })

  it('waits for work handed over while it settles, as a finalize that hands off more does', async () => {
    const ctx = recordingContext()
    const inner = gate()
    ctx.waitUntil((async () => {
      await Promise.resolve()
      ctx.waitUntil(inner.promise)
    })())
    const settling = ctx.settle()
    await vi.waitFor(() => expect(ctx.handed).toHaveLength(2))
    expect(ctx.pending()).toBe(1)
    inner.open()
    await settling
    expect(ctx.pending()).toBe(0)
  })

  it('counts a rejected hand-off as finished, without an unhandled rejection', async () => {
    const ctx = recordingContext()
    ctx.waitUntil(Promise.reject(new Error('the background write failed')))
    await ctx.settle()
    expect(ctx.pending()).toBe(0)
  })

  it('waits in real time, so work on the real event loop finishes while the test fakes the clock', async () => {
    vi.useFakeTimers()
    const ctx = recordingContext()
    // Like a dynamic import, this moves in real time whatever the faked clock says.
    ctx.waitUntil(new Promise((resolve) => realSetTimeout(resolve, 20)))
    await ctx.settle()
    expect(ctx.pending()).toBe(0)
  })

  it('fails naming how much is still running once its bound passes, rather than hanging', async () => {
    const ctx = recordingContext()
    ctx.waitUntil(new Promise(() => {}))
    await expect(ctx.settle({ timeoutMs: 30 })).rejects.toThrow(/1 promise handed to waitUntil was still running after 30 ms/)
    ctx.forget()
  })
})

describe('settleAfterTest', () => {
  it('reports nothing when everything handed off had finished by the end of the test', async () => {
    const ctx = recordingContext()
    ctx.waitUntil(Promise.resolve())
    expect(await settleAfterTest()).toBeNull()
  })

  it('names work still running when the test ended, and lets it finish before the file can close', async () => {
    const ctx = recordingContext()
    const late = gate()
    ctx.waitUntil(late.promise)
    setTimeout(() => late.open(), 20)
    const report = await settleAfterTest()
    expect(report).toMatch(/1 promise handed to waitUntil was still running when the test ended/)
    expect(report).toMatch(/Await ctx\.settle\(\) before the test ends/)
    // Reported AND finished: nothing is left to log into a closed worker.
    expect(ctx.pending()).toBe(0)
  })

  it('counts work that finishes within microtasks as finished, as the platform would before the response is read', async () => {
    const ctx = recordingContext()
    ctx.waitUntil(Promise.resolve().then(() => Promise.resolve()).then(() => undefined))
    expect(await settleAfterTest()).toBeNull()
  })

  it('reports work that never settles at all, after its bound', async () => {
    const ctx = recordingContext()
    ctx.waitUntil(new Promise(() => {}))
    const report = await settleAfterTest({ timeoutMs: 30 })
    expect(report).toMatch(/still running when the test ended/)
    expect(report).toMatch(/still running after 30 ms/)
  })
})
