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
import type { SupabaseClient } from '@supabase/supabase-js'
import { LOOKBACK_DAYS, runArchiveBacklog, backlogDeps } from '../archive-backlog-run'
import { PAGE_SIZE } from '../paginate'
import { MAX_NO_PROGRESS_ATTEMPTS, SET_ASIDE_MS, emptyBacklogState, type BacklogState } from '../../archive/backlog'

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
  /** The remembered attempt state the run starts from (#1021). */
  state?: BacklogState
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

/**
 * The smallest client that records what the run record wrote, so a test can see
 * that the walk opened a row and closed it with an outcome.
 */
function jobRunRecorder(rows: Array<Record<string, unknown>>): SupabaseClient {
  return {
    from() {
      const chain: Record<string, unknown> = {
        insert(row: Record<string, unknown>) { rows.push({ op: 'insert', ...row }); return chain },
        update(row: Record<string, unknown>) { rows.push({ op: 'update', ...row }); return chain },
        eq() { return chain },
        select() { return chain },
        single() { return Promise.resolve({ data: { id: 'run-1' }, error: null }) },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({ data: [{ id: 'run-1' }], error: null }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

function deps(h: Harness = {}) {
  const held = h.held ?? ['2026-08-16', '2026-08-17']
  const counts = { ...(h.recorded ?? {}) }
  const recorded: Record<string, string[]> = {}
  for (const [day, n] of Object.entries(counts)) recorded[day] = scatteredHours(day, n)
  const runs: Array<{ day: string; hours: number; alreadyRecorded: number }> = []
  // Held by the harness rather than by the injected deps, so a test can assert on
  // what was PERSISTED instead of on what the run happened to return.
  let state: BacklogState = h.state ?? emptyBacklogState()
  const wrote = { any: false }
  const jobRuns: Array<Record<string, unknown>> = []

  const harness = {
    runs,
    get state() { return state },
    get written() { return wrote.any },
    jobRuns,
    injected: {
      // A real recording client, so the run record this walk now opens and
      // closes is exercised rather than stubbed away (#1251).
      supabase: jobRunRecorder(jobRuns),
      readState: async () => state,
      writeState: async (next: BacklogState) => {
        wrote.any = true
        state = next
      },
      alertSetAside: vi.fn(async (_message: string) => undefined),
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
    },
  }
  return harness
}

describe('runArchiveBacklog', () => {
  it('does nothing at all when every readable day is fully archived', async () => {
    const d = deps({ recorded: { '2026-08-16': 24, '2026-08-17': 24 } })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBeNull()
    expect(d.injected.reArchiveDay).not.toHaveBeenCalled()
    expect(d.injected.alertSetAside).not.toHaveBeenCalled()
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

  it('records a day that gained no hour, and stays quiet about one barren run', async () => {
    // Progress is judged by hours GAINED, not by the run reporting failure: the
    // observed failure mode returned success while making no progress (#1019).
    //
    // One barren run is routine, though: the invocation gets killed, a read times
    // out, Snowflake blips, and the next hourly run simply retries. Alerting on it
    // is the cry-wolf case (L36), so the alarm moved to the point where the walk
    // actually gives up on the day (#1021). Nothing is at risk in the meantime,
    // because the purge that threatens the day is nightly.
    const d = deps({ recorded: { '2026-08-16': 4 }, archives: { '2026-08-16': 0 } })

    const r = await runArchiveBacklog(d.injected)

    expect(r.progressed).toBe(false)
    expect(d.injected.alertSetAside).not.toHaveBeenCalled()
    expect(d.state.noProgress['2026-08-16']).toBe(1)
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

    expect(d.injected.alertSetAside).not.toHaveBeenCalled()
  })

  it('sets the day aside on the third barren run and says so, naming the shortfall', async () => {
    const d = deps({
      recorded: { '2026-08-16': 4 },
      archives: { '2026-08-16': 0 },
      state: { noProgress: { '2026-08-16': MAX_NO_PROGRESS_ATTEMPTS - 1 }, setAsideUntil: {} },
    })

    await runArchiveBacklog(d.injected)

    expect(d.injected.alertSetAside).toHaveBeenCalledTimes(1)
    const message = vi.mocked(d.injected.alertSetAside).mock.calls[0][0]
    expect(message).toMatch(/2026-08-16/)
    // The shortfall, not just the day: 4 of 24 held is what tells whoever reads
    // this how much data is about to be purged with no backup.
    expect(message).toMatch(/4 of 24/)
    expect(d.state.setAsideUntil['2026-08-16']).toBe(NOW.getTime() + SET_ASIDE_MS)
  })

  it('works on the next day once the hard one is set aside, instead of retrying it forever', async () => {
    // This is the whole point: one unfinishable day must not block every day
    // behind it, because those days get purged on their own schedule regardless.
    const d = deps({
      recorded: { '2026-08-16': 4, '2026-08-17': 0 },
      state: { noProgress: {}, setAsideUntil: { '2026-08-16': NOW.getTime() + SET_ASIDE_MS } },
    })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBe('2026-08-17')
  })

  it('retries a set-aside day once its window has passed', async () => {
    // Setting aside is not abandoning. The cause may have been transient.
    const d = deps({
      recorded: { '2026-08-16': 4, '2026-08-17': 24 },
      state: { noProgress: {}, setAsideUntil: { '2026-08-16': NOW.getTime() - 1 } },
    })

    const r = await runArchiveBacklog(d.injected)

    expect(r.day).toBe('2026-08-16')
  })

  it('clears the barren count when a day gains an hour', async () => {
    const d = deps({
      recorded: { '2026-08-16': 4 },
      state: { noProgress: { '2026-08-16': 2 }, setAsideUntil: {} },
    })

    await runArchiveBacklog(d.injected)

    expect(d.state.noProgress['2026-08-16']).toBeUndefined()
  })

  it('forgets a day Postgres no longer holds', async () => {
    const d = deps({
      held: ['2026-08-17'],
      recorded: { '2026-08-17': 24 },
      state: { noProgress: { '2026-08-10': 2 }, setAsideUntil: { '2026-08-10': NOW.getTime() + SET_ASIDE_MS } },
    })

    await runArchiveBacklog(d.injected)

    expect(d.state.noProgress['2026-08-10']).toBeUndefined()
    expect(d.state.setAsideUntil['2026-08-10']).toBeUndefined()
  })

  it('throws rather than writing an empty state when the state read fails', async () => {
    // A read-modify-write whose read answers empty on failure erases the whole
    // memory the first time the read fails, and it does so at the moment the
    // memory is worth having (L105): every day would look like it had never been
    // attempted, so nothing would ever be set aside.
    const d = deps({ recorded: { '2026-08-16': 4 } })
    d.injected.readState = async () => {
      throw new Error('KV unavailable')
    }

    await expect(runArchiveBacklog(d.injected)).rejects.toThrow(/KV unavailable/)
    expect(d.written).toBe(false)
  })
})

describe('the recorded-hours read stays under the PostgREST cap (#1191)', () => {
  // recordedHoursByDay reads one row per archived hour across LOOKBACK_DAYS, with
  // no page size: its bound is the date window. PostgREST answers at most
  // PAGE_SIZE rows to such a read and says nothing about the rest, so past that
  // point finished hours would read as missing and the walk would go back over
  // days already archived. The lookback was widened from 7 to 14 as a temporary
  // measure (#1038), and this is what stops the next widening from crossing the
  // line unnoticed (L188).
  it('LOOKBACK_DAYS worth of hours is well inside one PostgREST page', () => {
    const rows = LOOKBACK_DAYS * 24
    const maxDays = Math.floor((PAGE_SIZE - 1) / 24)
    expect(rows, `${LOOKBACK_DAYS} days is ${rows} hourly rows; the cap is ${PAGE_SIZE}, so the lookback must stay at or below ${maxDays} days, or the read must page`).toBeLessThan(PAGE_SIZE)
  })
})

/**
 * The wiring, not just the helper (#1025).
 *
 * `backlogDeps` had no test at all, so the walk's answer to "which days does
 * Postgres still hold" was only ever exercised through a double that replaced
 * it. Sharing the reader with the deletion gate is worth nothing if the walk's
 * copy asks a different window (L3).
 */
describe('backlogDeps asks Postgres the window the walk needs', () => {
  function heldDouble(holds: string[]) {
    const asked: Array<{ gte: string; lt: string }> = []
    const client = {
      from() {
        let gte = ''
        let lt = ''
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          gte: (_c: string, v: string) => { gte = v; return chain },
          lt: (_c: string, v: string) => { lt = v; return chain },
          limit: () => {
            asked.push({ gte, lt })
            return Promise.resolve({ data: holds.includes(gte.slice(0, 10)) ? [{ id: 'e' }] : [], error: null })
          },
        }
        return chain
      },
    }
    return { client, asked }
  }

  it('covers LOOKBACK_DAYS back to today, inclusive at both ends', async () => {
    const { client, asked } = heldDouble([])
    const deps = backlogDeps(
      {} as unknown as Parameters<typeof backlogDeps>[0],
      client as unknown as Parameters<typeof backlogDeps>[1],
      async () => ({ hoursArchived: 0, executionsArchived: 0, failed: false, detail: '' }) as never,
    )
    await deps.daysHeldInPostgres()

    // The window is what matters: one query per day, oldest first, and the
    // number of them is the lookback plus today.
    expect(asked).toHaveLength(LOOKBACK_DAYS + 1)
    const days = asked.map((a) => a.gte.slice(0, 10))
    expect(days[days.length - 1]).toBe(new Date().toISOString().slice(0, 10))
    expect(new Set(days).size).toBe(days.length)
    // Each question is bounded to its own day, so it touches one partition.
    for (const a of asked) {
      const span = Date.parse(a.lt) - Date.parse(a.gte)
      expect(span).toBe(24 * 60 * 60 * 1000)
    }
  })

  it('returns only the days that hold something', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { client } = heldDouble([today])
    const deps = backlogDeps(
      {} as unknown as Parameters<typeof backlogDeps>[0],
      client as unknown as Parameters<typeof backlogDeps>[1],
      async () => ({ hoursArchived: 0, executionsArchived: 0, failed: false, detail: '' }) as never,
    )
    expect(await deps.daysHeldInPostgres()).toEqual([today])
  })
})

/**
 * A run that dies inside the archive work still counts against the day (#1039).
 *
 * The count used to be persisted only after `reArchiveDay` returned, so an
 * invocation killed during it wrote nothing at all. The case the set-aside
 * exists for is a day the walk cannot finish, and the likeliest reason is that
 * its hours are too large for one invocation, which shows up as the invocation
 * being killed. Two runs on 2026-08-23 took the lock and never closed their row.
 */
describe('a run that never returns from the archive work', () => {
  it('has already persisted the attempt before the work starts', async () => {
    const d = deps({ recorded: { '2026-08-16': 4 } })
    // Nothing after reArchiveDay runs, which is what a killed invocation looks
    // like from the state's point of view.
    d.injected.reArchiveDay = vi.fn(async () => {
      throw new Error('the platform terminated this invocation')
    })

    await expect(runArchiveBacklog(d.injected)).rejects.toThrow('terminated')

    // The count is there. Before this it was zero, so a day that killed every
    // run was never set aside and blocked every day behind it.
    expect(d.state.noProgress['2026-08-16']).toBe(1)
  })

  it('accumulates across successive killed runs, until the day is set aside', async () => {
    const kill = () => {
      const d = deps({ recorded: { '2026-08-16': 4 } })
      d.injected.reArchiveDay = vi.fn(async () => {
        throw new Error('the platform terminated this invocation')
      })
      return d
    }

    let carried = { noProgress: {}, setAsideUntil: {} } as Record<string, Record<string, number>>
    for (let i = 0; i < 3; i++) {
      const d = kill()
      d.injected.readState = async () => carried as never
      await expect(runArchiveBacklog(d.injected)).rejects.toThrow('terminated')
      carried = d.state as never
    }

    expect(carried.noProgress['2026-08-16']).toBe(3)
  })
})
