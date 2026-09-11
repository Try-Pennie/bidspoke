/**
 * A killed archive run leaves a partial record saying how far it had got (#1034).
 *
 * Two runs on 2026-08-23 took the run lock and never closed their `job_runs`
 * row. That absence is the only evidence they were killed, and it says nothing
 * about the cause: out of memory, out of wall time, out of subrequests and a
 * platform blip all leave the identical trace. They are different fixes. An hour
 * too large to finish in one invocation can never be archived however often it
 * retries (#953), while a blip clears on the next run.
 *
 * So the run stamps its progress into the row it already opened, and the row a
 * killed run leaves behind carries the last stamp rather than nothing.
 */
import { describe, it, expect } from 'vitest'
import { runArchive, type RunDeps } from '../run-loop'
import { SETTLE_WINDOW_MS } from '../clock'

const HOUR = 60 * 60 * 1000
const WATERMARK = '2026-08-16T10:00:00.000Z'
const NOW = new Date(Date.parse(WATERMARK) + 30 * HOUR + SETTLE_WINDOW_MS)

interface FakeBundle { executionId: string; execution: Record<string, unknown>; steps: Record<string, unknown>[] }

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  let watermark = WATERMARK
  return {
    now: () => NOW,
    readWatermark: async () => watermark,
    advanceWatermark: async (hourStart) => {
      watermark = hourStart
    },
    streamHour: async (_s: string, _e: string, onSlice: (b: FakeBundle[]) => Promise<void>) => {
      await onSlice([{ executionId: 'e1', execution: { id: 'e1' }, steps: [] }])
      return { usable: true as const, empty: false, executionCount: 1, stepCount: 0, requests: 1 }
    },
    encode: async (bundle) => ({ executionId: bundle.executionId, wire: 'x', wireBytes: 10, stepCount: 0 }),
    send: async () => undefined,
    recordArchived: async () => undefined,
    recordRefusal: async () => undefined,
    recordHour: async () => undefined,
    recordProgress: async () => undefined,
    budget: { maxHours: 3, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
    ...overrides,
  } as RunDeps
}

describe('the archive stamps how far it has got (#1034)', () => {
  it('reports after every hour, so the last stamp is the last hour finished', async () => {
    const stamps: Array<{ hoursArchived: number; hoursEmpty: number }> = []
    await runArchive(
      deps({
        recordProgress: async (p) => {
          stamps.push({ hoursArchived: p.hoursArchived, hoursEmpty: p.hoursEmpty })
        },
      }),
    )

    expect(stamps).toHaveLength(3)
    // Counts that only ever grow, so the last row written is the furthest the
    // run reached rather than whichever hour happened to be stamped last.
    expect(stamps.map((s) => s.hoursArchived)).toEqual([1, 2, 3])
  })

  it('reports an empty hour too, because a run stuck on empties has also progressed', async () => {
    const stamps: Array<{ hoursArchived: number; hoursEmpty: number }> = []
    await runArchive(
      deps({
        streamHour: async () => ({ usable: true as const, empty: true, executionCount: 0, stepCount: 0, requests: 1 }),
        recordProgress: async (p) => {
          stamps.push({ hoursArchived: p.hoursArchived, hoursEmpty: p.hoursEmpty })
        },
      }),
    )

    expect(stamps.map((s) => s.hoursEmpty)).toEqual([1, 2, 3])
  })

  it('carries the hour it had just finished, so a killed run names where it died', async () => {
    const details: string[] = []
    await runArchive(
      deps({
        budget: { maxHours: 1, deadlineAt: NOW.getTime() + 10 * 60 * 1000, subrequestsLeft: () => 1000 },
        recordProgress: async (p) => {
          details.push(p.detail)
        },
      }),
    )

    expect(details).toHaveLength(1)
    expect(details[0]).toContain('2026-08-16T11:00:00.000Z')
  })

  it('keeps archiving when the stamp cannot be written', async () => {
    // Bookkeeping must never be able to stop the work it describes (L71). A
    // progress write that throws would otherwise turn a Supabase blip into the
    // killed run this exists to explain.
    const result = await runArchive(
      deps({
        recordProgress: async () => {
          throw new Error('supabase said no')
        },
      }),
    )

    expect(result.hoursArchived).toBe(3)
    expect(result.failed).toBe(false)
  })
})
