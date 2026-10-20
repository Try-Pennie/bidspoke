/**
 * The late step write on its own (#2541): which entries it takes, when it stops
 * waiting, and that it never writes an entry twice or throws.
 */
import { describe, it, expect, vi } from 'vitest'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'
import { PostResponseBudget, POST_RESPONSE_BUDGET_MS, DEAD_LETTER_RESERVE_MS, type RetryTiming } from '../../lib/post-response-budget'
import { StepFlushCursor, recordLateSteps, LATE_STEP_RESERVE_MS } from '../late-steps'
import type { StepLogEntry } from '../step-logger'

const entry = (ns: string): StepLogEntry => ({
  execution_id: 'exec-1',
  execution_started_at: '2026-10-20T15:11:27.386Z',
  step_namespace: ns,
  step_type: 'code',
  status: 'completed',
  input: null,
  output: null,
  retries_used: 0,
  started_at: '2026-10-20T15:11:37.671Z',
  completed_at: '2026-10-20T15:11:53.671Z',
  duration_ms: 16_000,
  step_order: 1,
})

function setup() {
  const clock = new VirtualClock()
  const budget = new PostResponseBudget(clock)
  budget.arm()
  const timing: RetryTiming = { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS }
  return { clock, budget, timing }
}

describe('StepFlushCursor', () => {
  it('hands each entry to one flush only', () => {
    const queue = [entry('a'), entry('b')]
    const cursor = new StepFlushCursor()
    expect(cursor.started).toBe(false)
    expect(cursor.take(queue).map((e) => e.step_namespace)).toEqual(['a', 'b'])
    expect(cursor.started).toBe(true)
    expect(cursor.take(queue)).toEqual([])
    queue.push(entry('c'))
    expect(cursor.take(queue).map((e) => e.step_namespace)).toEqual(['c'])
    expect(cursor.take(queue)).toEqual([])
  })
})

describe('recordLateSteps', () => {
  it('writes the entries pushed after the cut-off flush once the walk settles', async () => {
    const { clock, timing } = setup()
    const queue = [entry('answer')]
    const cursor = new StepFlushCursor()
    cursor.take(queue)
    const write = vi.fn(async (_entries: StepLogEntry[]) => null)
    const walk = clock.delay(16_000).then(() => queue.push(entry('late')))
    const done = recordLateSteps({ walk, mainFlush: Promise.resolve(), cursor, queue, write, timing, executionId: 'exec-1' })
    await clock.run()
    await done
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].map((e) => e.step_namespace)).toEqual(['late'])
  })

  it('writes nothing a second time when it runs twice', async () => {
    const { clock, timing } = setup()
    const queue = [entry('answer')]
    const cursor = new StepFlushCursor()
    cursor.take(queue)
    const write = vi.fn(async (_entries: StepLogEntry[]) => null)
    const walk = clock.delay(16_000).then(() => queue.push(entry('late')))
    const args = { walk, mainFlush: Promise.resolve(), cursor, queue, write, timing, executionId: 'exec-1' }
    const both = Promise.all([recordLateSteps(args), recordLateSteps(args)])
    await clock.run()
    await both
    expect(write.mock.calls.flatMap((c) => c[0].map((e) => e.step_namespace))).toEqual(['late'])
  })

  it('writes nothing when the cut-off flush never ran, since the rebuilt run is flushed whole elsewhere', async () => {
    const { clock, timing } = setup()
    const queue = [entry('answer')]
    const write = vi.fn(async (_entries: StepLogEntry[]) => null)
    const walk = clock.delay(16_000).then(() => queue.push(entry('late')))
    const done = recordLateSteps({ walk, mainFlush: Promise.resolve(), cursor: new StepFlushCursor(), queue, write, timing, executionId: 'exec-1' })
    await clock.run()
    await done
    expect(write).not.toHaveBeenCalled()
  })

  it('stops waiting at the late cut-off and writes only what settled by then', async () => {
    const { clock, timing } = setup()
    const lateCutOff = POST_RESPONSE_BUDGET_MS - LATE_STEP_RESERVE_MS
    const queue = [entry('answer')]
    const cursor = new StepFlushCursor()
    cursor.take(queue)
    const write = vi.fn(async (_entries: StepLogEntry[]) => null)
    const writtenAt: number[] = []
    write.mockImplementation(async () => {
      writtenAt.push(clock.now())
      return null
    })
    void clock.delay(15_000).then(() => queue.push(entry('in_time')))
    const walk = clock.delay(60_000).then(() => queue.push(entry('too_late')))
    const done = recordLateSteps({ walk, mainFlush: Promise.resolve(), cursor, queue, write, timing, executionId: 'exec-1' })
    await clock.run(lateCutOff)
    await done
    expect(write.mock.calls.flatMap((c) => c[0].map((e) => e.step_namespace))).toEqual(['in_time'])
    expect(writtenAt).toEqual([lateCutOff])
  })

  it('starts no write when the cut-off flush itself answered after the late cut-off', async () => {
    const { clock, timing } = setup()
    const queue = [entry('answer')]
    const cursor = new StepFlushCursor()
    const write = vi.fn(async (_entries: StepLogEntry[]) => null)
    const mainFlush = clock.delay(21_000).then(() => {
      cursor.take(queue)
      queue.push(entry('late'))
    })
    const done = recordLateSteps({ walk: Promise.resolve(), mainFlush, cursor, queue, write, timing, executionId: 'exec-1' })
    await clock.run()
    await done
    expect(write).not.toHaveBeenCalled()
  })

  it('never throws, whether the write throws or returns an error', async () => {
    const { clock, timing } = setup()
    const queue = [entry('answer')]
    const cursor = new StepFlushCursor()
    cursor.take(queue)
    queue.push(entry('late'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = recordLateSteps({ walk: Promise.resolve(), mainFlush: Promise.resolve(), cursor, queue, write: async () => { throw new Error('socket closed') }, timing, executionId: 'exec-1' })
    await clock.run()
    await expect(throwing).resolves.toBeUndefined()
    queue.push(entry('later'))
    const returning = recordLateSteps({ walk: Promise.resolve(), mainFlush: Promise.resolve(), cursor, queue, write: async () => '1/1 step rows failed: boom', timing, executionId: 'exec-1' })
    await clock.run()
    await expect(returning).resolves.toBeUndefined()
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/socket closed|could not/)
    expect(errors.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('boom')
    errors.mockRestore()
  })
})
