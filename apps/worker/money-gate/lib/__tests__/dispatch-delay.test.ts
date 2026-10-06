import { describe, expect, it } from 'vitest'
import { createGateIo } from '../../harness/gate-io'
import { parseDispatchDelay } from '../dispatch-delay'

const namespaces = [{ binding: 'DYNAMIC_WORKER_LOADER', namespace: 'bidspoke-code-nodes', outbound: null }]

describe('parseDispatchDelay (#1796)', () => {
  it('reads unset and empty as no delay', () => {
    expect(parseDispatchDelay(undefined)).toBe(0)
    expect(parseDispatchDelay('')).toBe(0)
  })

  it('reads a whole number of milliseconds', () => {
    expect(parseDispatchDelay('400')).toBe(400)
  })

  it('refuses anything that is not a non negative number, by name, rather than running undelayed', () => {
    expect(() => parseDispatchDelay('fast')).toThrow(/MONEY_GATE_DISPATCH_DELAY_MS must be a number of milliseconds, not fast/)
    expect(() => parseDispatchDelay('-5')).toThrow(/MONEY_GATE_DISPATCH_DELAY_MS/)
    expect(() => parseDispatchDelay('Infinity')).toThrow(/MONEY_GATE_DISPATCH_DELAY_MS/)
  })
})

describe('gate io dispatch delay (#1796)', () => {
  const dispatch = (handler: (r: Request) => Promise<Response>) =>
    handler(new Request('https://gate/dispatch?name=missing&namespace=bidspoke-code-nodes&path=%2Fexecute%2Fx', { method: 'POST', body: '{}' }))

  it('holds each dispatch for the delay it was given before answering', async () => {
    const slept: number[] = []
    const io = createGateIo({ outPath: undefined, fixedTimeMs: 0, dispatchNamespaces: namespaces, dispatchDelayMs: 400, sleep: async (ms) => { slept.push(ms) } })
    const res = await dispatch(io.handler)
    expect(res.status).toBe(404)
    expect(slept).toEqual([400])
  })

  it('does not wait at all when no delay is set', async () => {
    const slept: number[] = []
    const io = createGateIo({ outPath: undefined, fixedTimeMs: 0, dispatchNamespaces: namespaces, sleep: async (ms) => { slept.push(ms) } })
    const res = await dispatch(io.handler)
    expect(res.status).toBe(404)
    expect(slept).toEqual([])
  })
})
