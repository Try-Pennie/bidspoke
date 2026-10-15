import { describe, expect, it } from 'vitest'
import { trackInflight } from './inflight.ts'

function deferred() {
  let resolve: (value: string) => void = () => {}
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('trackInflight', () => {
  it('waits for a remote call already in flight before reporting settled', async () => {
    const d = deferred()
    const order: string[] = []
    const tracked = trackInflight({ createAuthUser: () => d.promise.then((v) => (order.push('landed'), v)) }, ['createAuthUser'])
    void tracked.deps.createAuthUser()
    const settled = tracked.settle(1000).then((ok) => (order.push('settled'), ok))
    d.resolve('user-1')
    expect(await settled).toBe(true)
    expect(order).toEqual(['landed', 'settled'])
  })

  it('refuses new remote calls once stopped, so nothing is created behind the cleanup', async () => {
    let calls = 0
    const tracked = trackInflight({ createOrganization: async () => (calls += 1) }, ['createOrganization'])
    tracked.stop()
    await expect(tracked.deps.createOrganization()).rejects.toThrow(/interrupted/)
    expect(calls).toBe(0)
  })

  it('reports not settled when a call outlives the wait, rather than claiming it finished', async () => {
    const tracked = trackInflight({ hang: () => new Promise<never>(() => {}) }, ['hang'])
    void tracked.deps.hang()
    expect(await tracked.settle(10)).toBe(false)
  })

  it('leaves the methods it was not asked to track alone', () => {
    const tracked = trackInflight({ now: () => 42, dbSend: async () => 'x' }, ['dbSend'])
    tracked.stop()
    expect(tracked.deps.now()).toBe(42)
  })
})
