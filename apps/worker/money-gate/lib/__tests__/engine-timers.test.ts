import { describe, expect, it } from 'vitest'
import { GATE_STEP_DEADLINE_MS } from '../step-deadlines'
import { describeFiredTimers, liftEngineTimers, type TimerHost } from '../engine-timers'

/**
 * A host made of the real timers, so these tests never replace a global the test
 * runner itself relies on. The waits are real and short: the subject is what a
 * wall clock timer does while work is still in flight.
 */
function host(): TimerHost {
  return { setTimeout: globalThis.setTimeout, AbortSignal: { timeout: (ms: number) => AbortSignal.timeout(ms) } }
}

const after = (ms: number): Promise<'work'> => new Promise((resolve) => globalThis.setTimeout(() => resolve('work'), ms))

/** The shape of every budget on the bidding path: the work raced against a timer. */
function race(h: TimerHost, deadlineMs: number, workMs: number): Promise<'work' | 'deadline'> {
  return Promise.race([after(workMs), new Promise<'deadline'>((resolve) => h.setTimeout(() => resolve('deadline'), deadlineMs))])
}

describe('liftEngineTimers (#1872)', () => {
  it('a deadline shorter than the work wins the race without the lift, so the race below is a real one', async () => {
    expect(await race(host(), 5, 60)).toBe('deadline')
  })

  it('under the lift the work wins, however short the deadline the engine asked for', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    try {
      expect(await race(h, 5, 60)).toBe('work')
      expect(lift.fired()).toEqual([])
    } finally {
      lift.restore()
    }
  })

  it('raises every timer to the gate deadline by default, the one #1796 lifts definition timeouts to', () => {
    const asked: number[] = []
    const h: TimerHost = { ...host(), setTimeout: ((fn: () => void, ms?: number) => { asked.push(ms ?? 0); return globalThis.setTimeout(fn, 0) }) as typeof setTimeout }
    const lift = liftEngineTimers(h)
    try {
      globalThis.clearTimeout(h.setTimeout(() => {}, 800))
      globalThis.clearTimeout(h.setTimeout(() => {}))
    } finally {
      lift.restore()
    }
    expect(asked).toEqual([GATE_STEP_DEADLINE_MS, GATE_STEP_DEADLINE_MS])
  })

  it('records a timer that fires anyway, with the length the engine asked for and where it was set', async () => {
    const h = host()
    const lift = liftEngineTimers(h, { floorMs: 10 })
    try {
      await new Promise<void>((resolve) => h.setTimeout(resolve, 3))
      const fired = lift.fired()
      expect(fired).toHaveLength(1)
      expect(fired[0].requestedMs).toBe(3)
      expect(fired[0].kind).toBe('setTimeout')
      expect(fired[0].where).toContain('engine-timers.test.ts')
    } finally {
      lift.restore()
    }
  })

  it('passes the arguments a timer was set with to its callback', async () => {
    const h = host()
    const lift = liftEngineTimers(h, { floorMs: 1 })
    try {
      const got = await new Promise<unknown[]>((resolve) => h.setTimeout((...args: unknown[]) => resolve(args), 0, 'a', 2))
      expect(got).toEqual(['a', 2])
    } finally {
      lift.restore()
    }
  })

  it('a timer cleared before it fires is not recorded', async () => {
    const h = host()
    const lift = liftEngineTimers(h, { floorMs: 5 })
    try {
      globalThis.clearTimeout(h.setTimeout(() => {}, 1))
      await after(30)
      expect(lift.fired()).toEqual([])
    } finally {
      lift.restore()
    }
  })

  it('lifts AbortSignal.timeout too, and records one that aborts anyway', async () => {
    const h = host()
    const lifted = liftEngineTimers(h)
    try {
      const signal = h.AbortSignal.timeout(5)
      await after(40)
      expect(signal.aborted).toBe(false)
    } finally {
      lifted.restore()
    }

    const short = liftEngineTimers(h, { floorMs: 10 })
    try {
      const signal = h.AbortSignal.timeout(2)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      expect(short.fired()).toMatchObject([{ kind: 'AbortSignal.timeout', requestedMs: 2 }])
    } finally {
      short.restore()
    }
  })

  it('restore puts back exactly what it replaced', () => {
    const h = host()
    const before = { setTimeout: h.setTimeout, timeout: h.AbortSignal.timeout }
    const lift = liftEngineTimers(h)
    expect(h.setTimeout).not.toBe(before.setTimeout)
    expect(h.AbortSignal.timeout).not.toBe(before.timeout)
    lift.restore()
    expect(h.setTimeout).toBe(before.setTimeout)
    expect(h.AbortSignal.timeout).toBe(before.timeout)
  })
})

describe('describeFiredTimers (#1872)', () => {
  it('names the fixture, each timer and where it was set, so a red points at the code', () => {
    const text = describeFiredTimers('Engine Bidding Workflow/tripoint_declined_click_eligible', [
      { kind: 'setTimeout', requestedMs: 800, where: 'withDeadline (packages/buyer-profile/src/deadline.ts:29:27)' },
    ])
    expect(text).toContain('Engine Bidding Workflow/tripoint_declined_click_eligible')
    expect(text).toContain('setTimeout of 800 ms')
    expect(text).toContain('packages/buyer-profile/src/deadline.ts:29:27')
  })

  it('says nothing when no timer fired', () => {
    expect(describeFiredTimers('x', [])).toBe('')
  })
})
