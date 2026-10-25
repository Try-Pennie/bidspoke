import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The canvas's node test request (#2339).
 *
 * An ops App Action step test can run up to 95 s on ops, so testNode waits the
 * long timeout rather than the 30 s default, which would abort a test still
 * running and report it as timed out. And the person's tick that the test may
 * send for real travels as confirm_send on that one request, absent otherwise.
 */
vi.mock('../supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } }),
}))

import { api } from '../api'

const ANSWER = { output: null, status: 'completed', error_message: null, duration_ms: 1 }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A fetch that answers only when told, recording what it was sent and whether it was aborted. */
function holdingFetch() {
  const calls: Array<{ body: unknown; signal: AbortSignal }> = []
  let answer: (() => void) | null = null
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal })
    return new Promise<Response>((resolve, reject) => {
      answer = () => resolve(new Response(JSON.stringify(ANSWER), { status: 200 }))
      ;(init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  }))
  return { calls, answer: () => answer?.() }
}

describe('api.workflows.testNode', () => {
  it('sends confirm_send only when the person ticked it', async () => {
    const f = holdingFetch()
    const ticked = api.workflows.testNode('wf-1', { namespace: 'notify', definition: {}, confirm_send: true })
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    f.answer()
    await ticked
    const plain = api.workflows.testNode('wf-1', { namespace: 'notify', definition: {} })
    await vi.waitFor(() => expect(f.calls).toHaveLength(2))
    f.answer()
    await plain
    expect(f.calls[0].body).toMatchObject({ namespace: 'notify', confirm_send: true })
    expect(f.calls[1].body).not.toHaveProperty('confirm_send')
  })

  it('waits past the 30 s default for an ops step test, and still gives up in the end', async () => {
    vi.useFakeTimers()
    const f = holdingFetch()
    const run = api.workflows.testNode('wf-1', { namespace: 'notify', definition: {} })
    const settled = run.then(() => 'answered', (e: Error) => e.name)
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(95_000)
    expect(f.calls[0].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.calls[0].signal.aborted).toBe(true)
    expect(await settled).toBe('TimeoutError')
  })
})
