import { describe, it, expect } from 'vitest'
interface FakeBundle { executionId: string; execution: Record<string, unknown>; steps: Record<string, unknown>[] }

import { runArchive, reArchiveHours, type RunDeps, type RunStop } from '../run-loop'
import { SETTLE_WINDOW_MS } from '../clock'
import { SnowflakeNotSentError } from '../../lib/snowflake'

const HOUR = 60 * 60 * 1000
const WATERMARK = '2026-08-16T10:00:00.000Z'
/** Far enough ahead that many hours are closed and settled. */
const NOW = new Date(Date.parse(WATERMARK) + 30 * HOUR + SETTLE_WINDOW_MS)

type TestDeps = RunDeps & {
  sent: string[][]
  recorded: string[][]
  hoursRecorded: Array<{ hourStart: string; executionCount: number; stepCount: number }>
}

function deps(overrides: Partial<RunDeps> = {}): TestDeps {
  const sent: string[][] = []
  const recorded: string[][] = []
  const hoursRecorded: Array<{ hourStart: string; executionCount: number; stepCount: number }> = []
  let watermark = WATERMARK
  return {
    now: () => NOW,
    readWatermark: async () => watermark,
    advanceWatermark: async (hourEnd) => {
      watermark = hourEnd
    },
    streamHour: async (_hourStart: string, _hourEnd: string, onSlice: (b: FakeBundle[]) => Promise<void>) => {
      await onSlice([{ executionId: 'e1', execution: { id: 'e1' }, steps: [] }])
      return {
      usable: true as const,
      empty: false,
        executionCount: 1,
        stepCount: 0,
        requests: 1,
      }
    },
    encode: async (bundle) => ({ executionId: bundle.executionId, wire: 'x', wireBytes: 10, stepCount: 0 }),
    send: async (batch) => {
      sent.push(batch.map((b) => b.executionId))
    },
    recordArchived: async (ids) => {
      recorded.push(ids)
    },
    recordRefusal: async () => undefined,
    // Recorded per hour so the deletion gate can sum them instead of scanning
    // the day (#872). Captured here so the ordering test can see it.
    recordHour: async (hourStart: string, counts: { executionCount: number; stepCount: number }) => {
      hoursRecorded.push({ hourStart, ...counts })
    },
    budget: { maxHours: 100, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    sent,
    recorded,
    hoursRecorded,
    ...overrides,
  } as TestDeps
}

describe('the per-hour counts the deletion gate sums (#872)', () => {
  it('records an hour BEFORE advancing past it', async () => {
    // The other order lets a crash between the two leave an hour the watermark
    // has passed with no row, which the gate reads as an hour that was never
    // archived and which nothing will ever fill: the watermark never goes back.
    const order: string[] = []
    const d = deps({
      recordHour: async () => { order.push('record') },
      advanceWatermark: async () => { order.push('advance') },
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    })

    await runArchive(d)

    expect(order).toEqual(['record', 'advance'])
  })

  it('records an EMPTY hour too, with zeros', async () => {
    // A day is 24 hours and a missing row is how the gate detects an hour that
    // was never archived. Skipping the quiet ones would refuse every quiet
    // night for a reason that names counting rather than quiet.
    const d = deps({
      streamHour: async () => ({ usable: true as const, empty: true, executionCount: 0, stepCount: 0, requests: 1 }),
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    })

    const result = await runArchive(d)

    expect(result.hoursEmpty).toBe(1)
    expect(d.hoursRecorded).toEqual([
      { hourStart: d.hoursRecorded[0].hourStart, executionCount: 0, stepCount: 0 },
    ])
  })

  it('records the counts the hour actually reconciled against, not the loop\'s own tally', async () => {
    const d = deps({
      streamHour: async (_s, _e, onSlice) => {
        await onSlice([{ executionId: 'e1', execution: {}, steps: [] }])
        return { usable: true as const, empty: false, executionCount: 7, stepCount: 83, requests: 1 }
      },
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    })

    await runArchive(d)

    expect(d.hoursRecorded[0].executionCount).toBe(7)
    expect(d.hoursRecorded[0].stepCount).toBe(83)
  })

  it('records nothing for an hour that did not reconcile', async () => {
    // A row here means the hour reconciled. Recording an unusable hour would
    // give the gate a count taken from a read that did not add up.
    const d = deps({
      streamHour: async () => ({ usable: false as const, reason: 'counts did not match', requests: 1 }),
    })

    const result = await runArchive(d)

    expect(result.stop).toBe('read-failed')
    expect(d.hoursRecorded).toEqual([])
  })
})

describe('runArchive', () => {
  it('drains many hours in one run, so an outage does not become a permanent lag', async () => {
    const d = deps()
    const result = await runArchive(d)

    expect(result.hoursArchived).toBeGreaterThan(5)
    expect(result.stop).toBe<RunStop>('caught-up')
  })

  // The watermark identifies an hour by its START, so advancing it to the hour's
  // END skips every other hour. Nothing else notices: each run reports success,
  // the watermark moves forward, and half the executions are simply never
  // archived, surfacing weeks later as a deletion gate refusing alternate days.
  it('archives contiguous hours, leaving no gap between them', async () => {
    const asked: string[] = []
    const d = deps({
      budget: { maxHours: 6, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
      streamHour: async (hourStart: string, _hourEnd: string, onSlice: (b: FakeBundle[]) => Promise<void>) => {
        asked.push(hourStart)
        await onSlice([])
        return { usable: true as const, empty: false, executionCount: 0, stepCount: 0, requests: 1 }
      },
    })

    await runArchive(d)

    expect(asked.length).toBeGreaterThan(1)
    for (let i = 1; i < asked.length; i++) {
      expect(Date.parse(asked[i]) - Date.parse(asked[i - 1]), `gap before ${asked[i]}`).toBe(HOUR)
    }
    expect(asked[0]).toBe('2026-08-16T11:00:00.000Z')
  })

  it('stops when the next hour is not ready, and says so distinctly', async () => {
    const d = deps({ readWatermark: async () => new Date(NOW.getTime() - HOUR).toISOString() })
    const result = await runArchive(d)

    expect(result.hoursArchived).toBe(0)
    expect(result.stop).toBe<RunStop>('caught-up')
    expect(result.detail).toMatch(/has not closed|settle window/)
  })

  it('reports an hour with no executions as its own outcome, worded differently from a full one', async () => {
    const d = deps({
      streamHour: async () => ({ usable: true as const, empty: true, executionCount: 0, stepCount: 0, requests: 1 }),
    })
    const result = await runArchive(d)

    expect(result.hoursEmpty).toBeGreaterThan(0)
    expect(result.executionsArchived).toBe(0)
    expect(result.detail).not.toMatch(/archived everything/)
  })

  it('sends to Snowflake BEFORE recording the id locally', async () => {
    const order: string[] = []
    const d = deps({
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
      send: async () => {
        order.push('send')
      },
      recordArchived: async () => {
        order.push('record')
      },
    })

    await runArchive(d)

    expect(order).toEqual(['send', 'record'])
  })

  it('does not record ids locally when the send failed', async () => {
    const recorded: string[][] = []
    const d = deps({
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
      send: async () => {
        throw new Error('snowflake refused')
      },
      recordArchived: async (ids) => {
        recorded.push(ids)
      },
    })

    const result = await runArchive(d)

    expect(recorded).toEqual([])
    expect(result.stop).toBe<RunStop>('send-failed')
  })

  it('leaves the watermark where it got to when a send fails, so the hour is retried', async () => {
    let watermark = WATERMARK
    const d = deps({
      readWatermark: async () => watermark,
      advanceWatermark: async (hourEnd) => {
        watermark = hourEnd
      },
      send: async () => {
        throw new Error('snowflake refused')
      },
    })

    await runArchive(d)

    expect(watermark).toBe(WATERMARK)
  })

  it('refuses the hour and does not advance when the read did not reconcile', async () => {
    let watermark = WATERMARK
    const d = deps({
      readWatermark: async () => watermark,
      advanceWatermark: async (hourEnd) => {
        watermark = hourEnd
      },
      streamHour: async () => ({ usable: false as const, reason: 'steps: batch returned fewer rows', requests: 1 }),
    })

    const result = await runArchive(d)

    expect(watermark).toBe(WATERMARK)
    expect(result.stop).toBe<RunStop>('read-failed')
    expect(result.detail).toMatch(/fewer rows/)
  })

  it('stops cleanly on the wall-time budget, keeping the hours it finished', async () => {
    let clock = NOW.getTime()
    const d = deps({
      now: () => new Date(clock),
      send: async () => {
        clock += 5 * 60 * 1000
      },
      budget: { maxHours: 100, deadlineAt: NOW.getTime() + 6 * 60 * 1000, subrequestsLeft: () => 1000 },
    })

    const result = await runArchive(d)

    expect(result.stop).toBe<RunStop>('wall-time')
    expect(result.hoursArchived).toBeGreaterThan(0)
  })

  it('stops cleanly when subrequests run low', async () => {
    // Starts well above the floor and crosses it while working, so the stop is
    // reached by doing the work rather than by never starting.
    let left = 200
    const d = deps({
      budget: { maxHours: 100, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => left },
      send: async () => {
        left -= 40
      },
    })

    const result = await runArchive(d)

    expect(result.stop).toBe<RunStop>('subrequests')
    expect(result.hoursArchived).toBeGreaterThan(0)
  })

  // A clean stop is not a failure and must not touch the failure state: an
  // hourly job that alternates a transient failure with a clean stop would
  // otherwise re-arm the grace every other run and never reach the second
  // consecutive failure that pages (L53).
  it('marks a clean stop as not a failure', async () => {
    const d = deps({
      budget: { maxHours: 2, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    })

    const result = await runArchive(d)

    expect(result.failed).toBe(false)
  })

  it('marks a send failure as a failure', async () => {
    const d = deps({
      send: async () => {
        throw new Error('snowflake refused')
      },
    })

    const result = await runArchive(d)

    expect(result.failed).toBe(true)
  })

  it('refuses a bundle that will not encode, by id, and keeps the rest of the hour', async () => {
    const refusals: Array<{ executionId: string; reason: string }> = []
    const d = deps({
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
      streamHour: async (_hourStart: string, _hourEnd: string, onSlice: (b: FakeBundle[]) => Promise<void>) => {
        await onSlice([
          { executionId: 'good', execution: { id: 'good' }, steps: [] },
          { executionId: 'bad', execution: { id: 'bad' }, steps: [] },
        ])
        return {
        usable: true as const,
        empty: false,
          executionCount: 2,
          stepCount: 0,
          requests: 1,
        }
      },
      encode: async (bundle) => {
        if (bundle.executionId === 'bad') throw new Error('gzip exploded')
        return { executionId: bundle.executionId, wire: 'x', wireBytes: 10, stepCount: 0 }
      },
      recordRefusal: async (executionId, reason) => {
        refusals.push({ executionId, reason })
      },
    })

    const result = await runArchive(d)

    expect(refusals).toEqual([{ executionId: 'bad', reason: expect.stringContaining('gzip exploded') }])
    expect(result.executionsArchived).toBe(1)
    expect(result.executionsRefused).toBe(1)
  })

  // A permanent per-execution failure must NOT hold the watermark: one such row
  // would otherwise stop all archiving forever with nothing able to clear it.
  it('advances past an hour containing a refused execution', async () => {
    let watermark = WATERMARK
    const d = deps({
      readWatermark: async () => watermark,
      advanceWatermark: async (hourEnd) => {
        watermark = hourEnd
      },
      budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
      encode: async () => {
        throw new Error('gzip exploded')
      },
    })

    await runArchive(d)

    expect(watermark).not.toBe(WATERMARK)
  })
})

// L13: a background job must alert on zero work done while a backlog grows. Every
// clean stop here is honestly successful, so a run that stops on its budget
// without catching up reports success while the lag grows forever. The loop
// therefore reports how far behind it still is, and the alerting half thresholds
// that rather than the stop reason.
describe('runArchive reports how far behind it still is', () => {
  it('reports zero when it caught up', async () => {
    const d = deps()
    const result = await runArchive(d)

    expect(result.stop).toBe<RunStop>('caught-up')
    expect(result.hoursBehind).toBe(0)
  })

  it('reports the remaining lag when it stopped on a budget', async () => {
    const d = deps({
      budget: { maxHours: 2, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    })
    const result = await runArchive(d)

    expect(result.stop).toBe<RunStop>('max-hours')
    expect(result.hoursBehind).toBeGreaterThan(20)
  })

  it('reports the lag even when the run failed, so a stuck hour is visible as lag too', async () => {
    const d = deps({
      streamHour: async () => ({ usable: false as const, reason: 'steps: batch returned fewer rows', requests: 1 }),
    })
    const result = await runArchive(d)

    expect(result.failed).toBe(true)
    expect(result.hoursBehind).toBeGreaterThan(20)
  })
})

describe('a repair that is bigger than one run (#1019)', () => {
  const DAY = Array.from({ length: 24 }, (_, i) =>
    new Date(Date.parse('2026-08-16T00:00:00.000Z') + i * HOUR).toISOString(),
  )

  it('spends its budget on hours that are NOT yet recorded, so successive runs advance', async () => {
    // Measured on prod 2026-08-23: a day whose hours cost more than one run's
    // budget stayed at 2 of 24 hours through 40 minutes of calls, because every
    // call restarted at hour 00 and redid the two it could afford. A repair that
    // cannot advance is not a repair, and it returned 200 every time.
    const d = deps({ budget: { maxHours: 2, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 } })

    const first = await reArchiveHours(d, DAY, { alreadyRecorded: new Set() })
    const done = new Set(d.hoursRecorded.map((h) => h.hourStart))
    const second = await reArchiveHours(d, DAY, { alreadyRecorded: done })

    // The second run must work on hours the first did not reach.
    const secondHours = d.hoursRecorded.slice(first.hoursArchived + first.hoursEmpty).map((h) => h.hourStart)
    expect(secondHours).not.toEqual([])
    for (const h of secondHours) expect(done.has(h)).toBe(false)
    expect(second.hoursArchived + second.hoursEmpty).toBeGreaterThan(0)
  })

  it('reports hours it skipped as already done separately from hours a budget stopped', async () => {
    // Two different facts. "Already archived" needs no action; "ran out of
    // budget" means call again. Collapsing them into one number leaves a caller
    // unable to tell a finished day from a starved one (L11).
    const d = deps({ budget: { maxHours: 2, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 } })

    const r = await reArchiveHours(d, DAY, { alreadyRecorded: new Set([DAY[0], DAY[1]]) })

    expect(r.alreadyDone).toEqual([DAY[0], DAY[1]])
    expect(r.alreadyDone).not.toContain(DAY[2])
    // Being already done must not consume the budget meant for real work.
    expect(r.hoursArchived + r.hoursEmpty).toBe(2)
    expect(r.skipped.length).toBeGreaterThan(0)
  })

  it('still redoes a named hour when no recorded set is supplied, so a deliberate repair works', async () => {
    // The single-hour form exists to redo an hour that was archived WRONGLY.
    // Skipping it because a row already exists would remove the only way to fix
    // a bad archive.
    const d = deps()

    const r = await reArchiveHours(d, [DAY[0]])

    expect(r.hoursArchived + r.hoursEmpty).toBe(1)
    expect(r.alreadyDone).toEqual([])
  })
})

/**
 * The budget reserves room for the hour it is about to start (#953).
 *
 * The check used to be `now >= deadline`, which stops a run only once the
 * budget is already gone. An hour runs to completion once begun, so a run at
 * 590 seconds of a 600 second budget started another hour and overshot by that
 * hour's entire cost. Measured over 14 days of production run records: the
 * three runs that archived two hours took 372, 578 and 646 seconds against a
 * 600 second budget.
 *
 * Overshooting is not tidiness. The margin between the budget and the
 * platform's 15 minute cron ceiling is what stops the isolate being KILLED, and
 * a killed run writes no record, closes nothing and sends no alert (L98).
 */
describe('the wall budget reserves room for the next hour', () => {
  /** A clock the test moves, so an hour can be made to cost what it likes. */
  function movingClock(startMs: number) {
    let atMs = startMs
    return {
      now: () => new Date(atMs),
      advance: (ms: number) => { atMs += ms },
      get atMs() { return atMs },
    }
  }

  /** Deps whose every archived hour costs `hourCostMs` of wall time. */
  function depsCostingPerHour(hourCostMs: number, budgetMs: number, clock: ReturnType<typeof movingClock>) {
    const base = deps()
    return {
      ...base,
      now: clock.now,
      streamHour: async (...args: Parameters<typeof base.streamHour>) => {
        const out = await base.streamHour(...args)
        clock.advance(hourCostMs)
        return out
      },
      budget: {
        maxHours: 100,
        deadlineAt: clock.atMs + budgetMs,
        subrequestsLeft: () => 1000,
      },
    } as typeof base
  }

  it('always attempts a first hour, however little budget is left', async () => {
    // A run that cannot afford one hour has nothing to offer, so the reserve
    // must never stop a run before it has done anything.
    const clock = movingClock(NOW.getTime())
    const deps = depsCostingPerHour(300_000, 60_000, clock)

    const result = await runArchive(deps)

    expect(result.hoursArchived).toBeGreaterThanOrEqual(1)
  })

  it('stops rather than starting an hour it cannot finish inside the budget', async () => {
    // 350s hours against a 600s budget: one fits, a second would end at 700s.
    const clock = movingClock(NOW.getTime())
    const deps = depsCostingPerHour(350_000, 600_000, clock)

    const result = await runArchive(deps)

    expect(result.stop).toBe('wall-time')
    expect(result.hoursArchived).toBe(1)
    // The elapsed time never passes the budget, which is the property that
    // keeps the run inside the platform's ceiling.
    expect(clock.atMs - NOW.getTime()).toBeLessThanOrEqual(600_000)
  })

  it('says how much was left and what an hour costs, so the stop is diagnosable', async () => {
    const clock = movingClock(NOW.getTime())
    const deps = depsCostingPerHour(350_000, 600_000, clock)

    const result = await runArchive(deps)

    expect(result.detail).toMatch(/350s/)
    expect(result.detail).toMatch(/less than/)
  })

  it('keeps going while the remaining budget still covers an hour', async () => {
    // 100s hours against a 600s budget: five fit, and the sixth is refused
    // with 100s left rather than started and overrun.
    const clock = movingClock(NOW.getTime())
    const deps = depsCostingPerHour(100_000, 600_000, clock)

    const result = await runArchive(deps)

    expect(result.hoursArchived).toBeGreaterThan(1)
    expect(clock.atMs - NOW.getTime()).toBeLessThanOrEqual(600_000)
  })
})

/**
 * #1591: a send refused because the run has no time left is the run's budget
 * stopping it, not Snowflake failing. So it stops the run cleanly, as the
 * wall-time budget does between hours, without paging anyone as a failure, and
 * the hour is left for the next run.
 */
describe('a send refused for lack of time (#1591)', () => {
  const outOfTime = async () => {
    throw new SnowflakeNotSentError('not sent: 30s left, and one attempt can take 120s')
  }

  it('stops the run on its wall-time budget, not as a failed send', async () => {
    const d = deps({ send: outOfTime })

    const result = await runArchive(d)

    expect(result.stop).toBe<RunStop>('wall-time')
    expect(result.failed).toBe(false)
    expect(result.detail).toMatch(/2026-08-16T10:00:00\.000Z|2026-08-16T11:00:00\.000Z/)
    expect(result.detail).toMatch(/not sent/)
  })

  it('leaves the watermark on the hour, so the next run archives it', async () => {
    let watermark = WATERMARK
    const d = deps({
      send: outOfTime,
      readWatermark: async () => watermark,
      advanceWatermark: async (h) => {
        watermark = h
      },
    })

    await runArchive(d)

    expect(watermark).toBe(WATERMARK)
    expect(d.hoursRecorded).toEqual([])
  })

  it('is reported by a re-archive as an hour the budget did not reach, not as a failed hour', async () => {
    const hours = ['2026-08-16T11:00:00.000Z', '2026-08-16T12:00:00.000Z']
    const d = deps({ send: outOfTime })

    const result = await reArchiveHours(d, hours)

    expect(result.failures).toEqual([])
    expect(result.skipped).toEqual(hours)
  })
})
