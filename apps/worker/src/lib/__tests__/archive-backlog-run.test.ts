/**
 * The scheduled walk that closes archive gaps the forward-only archiver leaves
 * behind (#1015).
 *
 * The hourly run advances a watermark and never looks back, so a day it did not
 * cover stays uncovered. Six such days existed on 2026-08-23 and nothing had
 * reported them, because the hourly run was healthy the whole time: it was busy
 * with the current hour. This walk is what goes back.
 *
 * It is deliberately NOT a backlog-clearing engine. One run does what one
 * invocation's budget allows (measured: two hours), so its job is to stop small
 * gaps becoming large ones and to say loudly when a day is not moving. A large
 * backlog still needs a deliberate push.
 */
import { describe, it, expect, vi } from 'vitest'
import { runArchiveBacklog } from '../archive-backlog-run'

const NOW = new Date('2026-08-23T18:00:00.000Z')

interface Harness {
  /** Days Postgres still holds executions for. */
  held?: string[]
  /** How many hours are already recorded, per day. */
  recorded?: Record<string, number>
  /** The archive watermark. */
  watermark?: string
  /** Hours the re-archive run records, per call, keyed by the day it was given. */
  archives?: Record<string, number>
}

/**
 * The hours a day is pretending to hold, deliberately NOT hours 00..N-1.
 *
 * A day with four hours recorded is not necessarily its first four, so a fixture
 * that made them contiguous would let an implementation assuming contiguity pass.
 */
function scatteredHours(day: string, count: number): string[] {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return Array.from({ length: count }, (_, i) => new Date(start + ((i * 2) % 24) * 3600000).toISOString())
}

function deps(h: Harness = {}) {
  const held = h.held ?? ['2026-08-16', '2026-08-17']
  const counts = { ...(h.recorded ?? {}) }
  const recorded: Record<string, string[]> = {}
  for (const [day, n] of Object.entries(counts)) recorded[day] = scatteredHours(day, n)
  const runs: Array<{ day: string; hours: number; alreadyRecorded: number }> = []

  return {
    runs,
    injected: {
      now: () => NOW,
      readWatermark: async () => h.watermark ?? '2026-08-22T23:00:00.000Z',
      daysHeldInPostgres: async () => held,
      recordedHoursByDay: async () => ({ ...recorded }),
      reArchiveDay: vi.fn(async (day: string, alreadyRecorded: ReadonlySet<string>) => {
        const gained = h.archives?.[day] ?? 2
        const have = new Set(recorded[day] ?? [])
        // Adds hours it does not already hold, so a repeated run cannot inflate
        // the count past a real day.
        for (const hour of scatteredHours(day, 24)) {
          if (have.size >= (recorded[day]?.length ?? 0) + gained) break
          have.add(hour)
        }
        recorded[day] = [...have]
        runs.push({ day, hours: gained, alreadyRecorded: alreadyRecorded.size })
        return { hoursArchived: gained, failed: false, detail: 'ok' }
      }),
      alert: vi.fn(async (_message: string) => undefined),
    },
  }
}

describe('runArchiveBacklog', () => {
  it('does nothing at all when every readable day is fully archived', async () => {
    const d = deps({ recorded: { '2026-08-16': 24, '2026-08-17': 24 } })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBeNull()
    expect(d.injected.reArchiveDay).not.toHaveBeenCalled()
    expect(d.injected.alert).not.toHaveBeenCalled()
  })

  it('works on the oldest day that is short, because that is the one nearest being purged', async () => {
    const d = deps({ recorded: { '2026-08-16': 4, '2026-08-17': 0 } })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBe('2026-08-16')
    expect(d.runs.map((x) => x.day)).toEqual(['2026-08-16'])
  })

  it('tells the repair which hours are already held, so it does not redo them', async () => {
    // Without this the run spends its budget on hours already archived and the
    // day never advances, which is the defect in #1019.
    const d = deps({ recorded: { '2026-08-16': 4 } })

    await runArchiveBacklog(d.injected)

    expect(d.runs[0].alreadyRecorded).toBe(4)
  })

  it('reports a day that recorded no new hour, because that cannot fix itself', async () => {
    // The observed failure mode returned SUCCESS while making no progress, so
    // progress is judged by hours gained rather than by the run not failing.
    const d = deps({ recorded: { '2026-08-16': 4 }, archives: { '2026-08-16': 0 } })

    const r = await runArchiveBacklog(d.injected)

    expect(r.progressed).toBe(false)
    expect(d.injected.alert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.injected.alert).mock.calls[0][0]).toMatch(/2026-08-16/)
  })

  it('leaves a day the live archiver has not finished alone', async () => {
    // Re-archiving a day still in flight records an hour count that understates
    // it, and the deletion gate reads that count, so the repair would make the
    // day look worse than leaving it.
    const d = deps({
      held: ['2026-08-23'],
      recorded: { '2026-08-23': 6 },
      watermark: '2026-08-23T14:00:00.000Z',
    })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBeNull()
    expect(d.injected.reArchiveDay).not.toHaveBeenCalled()
  })

  it('does not alert when it found nothing to do, because quiet is the healthy state', async () => {
    const d = deps({ recorded: { '2026-08-16': 24, '2026-08-17': 24 } })

    await runArchiveBacklog(d.injected)

    expect(d.injected.alert).not.toHaveBeenCalled()
  })
})
