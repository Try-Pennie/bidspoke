import { describe, it, expect } from 'vitest'
import { runArchive, type RunDeps, type RunStop } from '../run-loop'
import { SETTLE_WINDOW_MS } from '../clock'

const HOUR = 60 * 60 * 1000
const WATERMARK = '2026-08-16T10:00:00.000Z'
/** Far enough ahead that many hours are closed and settled. */
const NOW = new Date(Date.parse(WATERMARK) + 30 * HOUR + SETTLE_WINDOW_MS)

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  const sent: string[][] = []
  const recorded: string[][] = []
  let watermark = WATERMARK
  return {
    now: () => NOW,
    readWatermark: async () => watermark,
    advanceWatermark: async (hourEnd) => {
      watermark = hourEnd
    },
    fetchHour: async () => ({
      usable: true as const,
      empty: false,
      bundles: [{ executionId: 'e1', execution: { id: 'e1' }, steps: [] }],
      executionCount: 1,
      stepCount: 0,
    }),
    encode: async (bundle) => ({ executionId: bundle.executionId, wire: 'x', wireBytes: 10, stepCount: 0 }),
    send: async (batch) => {
      sent.push(batch.map((b) => b.executionId))
    },
    recordArchived: async (ids) => {
      recorded.push(ids)
    },
    recordRefusal: async () => undefined,
    budget: { maxHours: 100, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    sent,
    recorded,
    ...overrides,
  } as RunDeps & { sent: string[][]; recorded: string[][] }
}

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
      fetchHour: async (hourStart) => {
        asked.push(hourStart)
        return { usable: true as const, empty: false, bundles: [], executionCount: 0, stepCount: 0 }
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
      fetchHour: async () => ({ usable: true as const, empty: true, bundles: [], executionCount: 0, stepCount: 0 }),
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
      fetchHour: async () => ({ usable: false as const, reason: 'steps: batch returned fewer rows' }),
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
      fetchHour: async () => ({
        usable: true as const,
        empty: false,
        bundles: [
          { executionId: 'good', execution: { id: 'good' }, steps: [] },
          { executionId: 'bad', execution: { id: 'bad' }, steps: [] },
        ],
        executionCount: 2,
        stepCount: 0,
      }),
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
      fetchHour: async () => ({ usable: false as const, reason: 'steps: batch returned fewer rows' }),
    })
    const result = await runArchive(d)

    expect(result.failed).toBe(true)
    expect(result.hoursBehind).toBeGreaterThan(20)
  })
})
