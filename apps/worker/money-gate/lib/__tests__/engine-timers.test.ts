import { describe, expect, it } from 'vitest'
import { GATE_STEP_DEADLINE_MS } from '../step-deadlines'
import { describeFiredTimers, describeStillHeld, liftEngineTimers, type TimerHost } from '../engine-timers'

/**
 * A host made of the real timers, so these tests never replace a global the test
 * runner itself relies on. The waits are real and short: the subject is what a
 * wall clock timer does while work is still in flight.
 */
function host(): TimerHost {
  return { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, AbortSignal: { timeout: (ms: number) => AbortSignal.timeout(ms) } }
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

  it('refuses a handler that is not a function by name, rather than recording a timer that did nothing', () => {
    const h = host()
    const lift = liftEngineTimers(h)
    try {
      expect(() => h.setTimeout('alert(1)' as unknown as () => void, 5)).toThrow('setTimeout handler that is not a function')
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
    const before = { setTimeout: h.setTimeout, clearTimeout: h.clearTimeout, timeout: h.AbortSignal.timeout }
    const lift = liftEngineTimers(h)
    expect(h.setTimeout).not.toBe(before.setTimeout)
    expect(h.clearTimeout).not.toBe(before.clearTimeout)
    expect(h.AbortSignal.timeout).not.toBe(before.timeout)
    lift.restore()
    expect(h.setTimeout).toBe(before.setTimeout)
    expect(h.clearTimeout).toBe(before.clearTimeout)
    expect(h.AbortSignal.timeout).toBe(before.timeout)
  })
})

/**
 * Moving the replay's time on to the next engine timer (#3086). A buyer call that
 * never answers ends only when the call's own timer aborts it, and under the lift
 * that timer is 300 s of real time away. advanceUntil runs the timers that would
 * have fired first, early and in order, so a fixture of a call that never answers
 * waits for nothing.
 */
describe('advanceUntil (#3086)', () => {
  it('runs the pending timer due first at once, records it as advanced and not as fired, and stops when the condition holds', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    const ran: string[] = []
    try {
      h.setTimeout(() => ran.push('25 s'), 25_000)
      h.setTimeout(() => ran.push('20 s'), 20_000)
      const started = performance.now()
      await lift.advanceUntil(() => ran.length > 0)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(ran).toEqual(['20 s'])
      expect(lift.advanced()).toMatchObject([{ kind: 'setTimeout', requestedMs: 20_000 }])
      expect(lift.advanced()[0].where).toContain('engine-timers.test.ts')
      expect(lift.fired()).toEqual([])
    } finally {
      lift.restore()
    }
  })

  it('goes on in order of when each is due, the earlier set first on a tie, until the condition holds', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    const ran: string[] = []
    try {
      h.setTimeout(() => ran.push('b'), 2_000)
      h.setTimeout(() => ran.push('a'), 1_000)
      h.setTimeout(() => ran.push('c'), 2_000)
      h.setTimeout(() => ran.push('d'), 9_000)
      await lift.advanceUntil(() => ran.includes('c'))
      expect(ran).toEqual(['a', 'b', 'c'])
    } finally {
      lift.restore()
    }
  })

  it('counts a timer set after an advance from the time the advance reached', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    const ran: string[] = []
    try {
      // Set at 1 s, so due at 1 s + 5 s = 6 s: after the 4 s timer, before the 7 s one.
      h.setTimeout(() => { ran.push('1 s'); h.setTimeout(() => ran.push('6 s'), 5_000) }, 1_000)
      h.setTimeout(() => ran.push('4 s'), 4_000)
      h.setTimeout(() => ran.push('7 s'), 7_000)
      await lift.advanceUntil(() => ran.includes('7 s'))
      expect(ran).toEqual(['1 s', '4 s', '6 s', '7 s'])
    } finally {
      lift.restore()
    }
  })

  it('never runs a timer that was cleared, and refuses by name when nothing is left that could end the wait', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    let ran = false
    try {
      h.clearTimeout(h.setTimeout(() => { ran = true }, 20_000))
      await expect(lift.advanceUntil(() => false)).rejects.toThrow('no engine timer is pending')
      expect(ran).toBe(false)
    } finally {
      lift.restore()
    }
  })

  it('a timer it ran early never runs again when its real time comes', async () => {
    const h = host()
    const lift = liftEngineTimers(h, { floorMs: 20 })
    let runs = 0
    try {
      h.setTimeout(() => { runs++ }, 5)
      await lift.advanceUntil(() => runs > 0)
      await after(60)
      expect(runs).toBe(1)
      expect(lift.fired()).toEqual([])
    } finally {
      lift.restore()
    }
  })

  it('tells the caller how far time has moved before the timer runs, so a pinned clock can move with it', async () => {
    const h = host()
    const seen: Array<[string, number]> = []
    let now = 0
    const lift = liftEngineTimers(h, { onAdvance: (ms) => { now = ms; seen.push(['advance', ms]) } })
    try {
      h.setTimeout(() => seen.push(['ran', now]), 20_000)
      await lift.advanceUntil(() => seen.length > 1)
      expect(seen).toEqual([['advance', 20_000], ['ran', 20_000]])
    } finally {
      lift.restore()
    }
  })

  it('refuses by name to move time on once restored, and never moves the pinned clock again, so a walk that outlives its run cannot carry on unseen (#3137)', async () => {
    const h = host()
    const seen: number[] = []
    const lift = liftEngineTimers(h, { onAdvance: (ms) => seen.push(ms) })
    const held = lift.waitFor(new AbortController().signal, 7_500)
    lift.restore()
    await expect(held).rejects.toThrow('outlived its run')
    expect(seen).toEqual([])
  })

  it('counts the held answers still waiting on the replay time, so a run can refuse to end while one waits (#3137)', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    try {
      expect(lift.waiting()).toBe(0)
      const held = lift.waitFor(new AbortController().signal, 7_500)
      expect(lift.waiting()).toBe(1)
      expect(await held).toBe('elapsed')
      expect(lift.waiting()).toBe(0)
    } finally {
      lift.restore()
    }
  })

  it('ends a run by counting the answers still held, then refusing each of them, so the replay can stop by name on a walk that outlived it (#3137)', async () => {
    const h = host()
    const seen: number[] = []
    const lift = liftEngineTimers(h, { onAdvance: (ms) => seen.push(ms) })
    const held = lift.waitFor(new AbortController().signal, 7_500)
    expect(lift.end()).toBe(1)
    await expect(held).rejects.toThrow('outlived its run')
    expect(seen).toEqual([])
    expect(h.setTimeout).toBe(globalThis.setTimeout)
  })

  it('ends a run with nothing held as zero', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    expect(await lift.waitFor(new AbortController().signal, 7_500)).toBe('elapsed')
    expect(lift.end()).toBe(0)
  })

  it('with floorMs 0 keeps every length as the engine asked, and can still advance', async () => {
    const asked: number[] = []
    // A real timer far off for the engine's, so only the advance can run it; the lift's own settle turn (0 ms) stays real.
    const h: TimerHost = { ...host(), setTimeout: ((fn: () => void, ms?: number) => { asked.push(ms ?? 0); return globalThis.setTimeout(fn, ms ? 60_000 : 0) }) as typeof setTimeout }
    const lift = liftEngineTimers(h, { floorMs: 0 })
    let ran = false
    try {
      h.setTimeout(() => { ran = true }, 20_000)
      expect(asked).toEqual([20_000])
      await lift.advanceUntil(() => ran)
      expect(ran).toBe(true)
    } finally {
      lift.restore()
    }
  })
})

// The engine's step clock seam (EngineRuntime.stepClock, #2163), on the replay's
// time (#3138): a retry's backoff and each attempt's deadline, so a fixture can
// replay an attempt timing out and the retry after it with nothing waiting for real.
describe('stepClock (#3138)', () => {
  it('sleeps a retry backoff on the replay time: the pinned clock moves on by exactly that much, nothing waits for real, and nothing fires', async () => {
    const h = host()
    const moved: number[] = []
    const lift = liftEngineTimers(h, { onAdvance: (ms) => { moved.push(ms) } })
    try {
      const started = performance.now()
      await lift.stepClock.sleep(500)
      await lift.stepClock.sleep(1_000)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(moved).toEqual([500, 1_500])
      expect(lift.fired()).toEqual([])
      expect(lift.waiting()).toBe(0)
    } finally {
      lift.restore()
    }
  })

  it('watches an attempt deadline without moving time itself: it runs only when another wait reaches it', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    try {
      const watching = new AbortController()
      let timedOut = false
      void lift.stepClock.timer(3_750, watching.signal).then(() => { timedOut = true })
      // A real turn passes and nothing moves the time, so the deadline has not run.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
      expect(timedOut).toBe(false)
      // A held answer that would take 5 s waits on the replay time, which reaches the deadline first.
      const held = new AbortController()
      void lift.stepClock.timer(3_750, watching.signal).then(() => held.abort())
      expect(await lift.waitFor(held.signal, 5_000)).toBe('aborted')
      expect(timedOut).toBe(true)
    } finally {
      lift.restore()
    }
  })

  it('ends a deadline watch at once when the attempt answers, and leaves no timer pending to move time later', async () => {
    const h = host()
    const lift = liftEngineTimers(h)
    try {
      const answered = new AbortController()
      const watch = lift.stepClock.timer(3_750, answered.signal)
      answered.abort()
      await watch
      await expect(lift.advanceUntil(() => false)).rejects.toThrow('no engine timer is pending')
    } finally {
      lift.restore()
    }
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

describe('describeStillHeld (#3137)', () => {
  it('names the fixture and how many answers were still held, so a walk that outlived its run stops the replay by name', () => {
    const text = describeStillHeld('Main Flow/achieve_starts_7500ms_after_answer', 1)
    expect(text).toContain('Main Flow/achieve_starts_7500ms_after_answer')
    expect(text).toContain('1 answer(s) held on the replay\'s time were still waiting when the run ended')
  })

  it('says nothing when no answer was still held', () => {
    expect(describeStillHeld('x', 0)).toBe('')
  })
})
