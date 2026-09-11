/**
 * The backlog walk cannot outlive its own invocation (#1184).
 *
 * On 2026-08-25 the 14:00:40 UTC run left a `job_runs` row with no ending, and
 * the Workers analytics for that day show one invocation at exactly 900 seconds
 * of wall time with status `internalError`: Cloudflare's 15 minute cron limit,
 * reached and terminated.
 *
 * The walk reads before it works and reads again after, and the repair it calls
 * budgets its OWN wall time from its own start, not from the invocation's. So
 * the two together could commit to more than one invocation is allowed, and a
 * killed walk runs no `finally`, which leaves the run lock held until the
 * deadline rule reclaims it and costs the next forward run as well.
 *
 * The clock is injected, so none of this waits (L290, L524).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runArchiveBacklog,
  INVOCATION_CEILING_MS,
  INVOCATION_MARGIN_MS,
  MINIMUM_DAY_MS,
  type BacklogDeps,
} from '../archive-backlog-run'
import { emptyBacklogState, type BacklogState } from '../../archive/backlog'
import type { SupabaseClient } from '@supabase/supabase-js'

const START = Date.parse('2026-08-25T14:00:40.000Z')

/** A client that accepts the run record writes and answers like PostgREST. */
function recordingClient(): SupabaseClient {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }) }),
      update: () => ({ eq: () => ({ select: async () => ({ data: [{ id: 'run-1' }], error: null }) }) }),
    }),
  } as unknown as SupabaseClient
}

/**
 * @param spentBeforeWorkMs how long this run's own reads take, on the injected clock
 */
function deps(opts: { spentBeforeWorkMs: number }): {
  injected: BacklogDeps
  budgets: number[]
} {
  let atMs = START
  const budgets: number[] = []
  let state: BacklogState = emptyBacklogState()
  const recorded: Record<string, string[]> = { '2026-08-16': [] }

  const injected: BacklogDeps = {
    supabase: recordingClient(),
    now: () => new Date(atMs),
    readWatermark: async () => '2026-08-22T23:00:00.000Z',
    daysHeldInPostgres: async () => ['2026-08-16'],
    recordedHoursByDay: async () => {
      // The reads are where the invocation's time goes before any work starts.
      atMs += opts.spentBeforeWorkMs
      return { ...recorded }
    },
    reArchiveDay: vi.fn(async (day: string, _already: ReadonlySet<string>, wallMs: number) => {
      budgets.push(wallMs)
      recorded[day] = ['2026-08-16T00:00:00.000Z']
      return { hoursArchived: 1, failed: false, detail: 'ok' }
    }),
    readState: async () => state,
    writeState: async (next) => {
      state = next
    },
    alertSetAside: vi.fn(async () => undefined),
  }
  return { injected, budgets }
}

describe('the walk keeps inside its invocation (#1184)', () => {
  it('hands the repair only the wall time the invocation has left', async () => {
    // Two minutes gone on the reads before any archiving starts.
    const d = deps({ spentBeforeWorkMs: 120_000 })

    await runArchiveBacklog(d.injected)

    expect(d.budgets).toHaveLength(1)
    // Whatever is left of the ceiling once the margin and the time already
    // spent are taken off. Derived from the constants rather than written as a
    // number, so the assertion follows a change to either (L401).
    expect(d.budgets[0]).toBeLessThanOrEqual(INVOCATION_CEILING_MS - INVOCATION_MARGIN_MS - 120_000)
    expect(d.budgets[0]).toBeGreaterThan(0)
  })

  it('never hands out more than the ceiling, however fast the reads were', async () => {
    const d = deps({ spentBeforeWorkMs: 0 })

    await runArchiveBacklog(d.injected)

    expect(d.budgets[0]).toBeLessThanOrEqual(INVOCATION_CEILING_MS - INVOCATION_MARGIN_MS)
  })

  it('stops rather than starting a day it has no time left for', async () => {
    // The reads alone have eaten all but a sliver. Starting the day here spends
    // the remaining seconds reaching the same 900 second kill.
    const d = deps({ spentBeforeWorkMs: INVOCATION_CEILING_MS - INVOCATION_MARGIN_MS - MINIMUM_DAY_MS + 1_000 })

    const r = await runArchiveBacklog(d.injected)

    expect(d.injected.reArchiveDay).not.toHaveBeenCalled()
    expect(r.stop).toBe('wall-time')
  })

  it('says a truncated walk is truncated, not that the day is fully archived', async () => {
    // A walk that stopped on its budget having done nothing and a walk that
    // found nothing to do are the same outcome from outside unless it says so
    // (L98), and they call for opposite reactions.
    const stopped = deps({ spentBeforeWorkMs: INVOCATION_CEILING_MS })
    const r = await runArchiveBacklog(stopped.injected)

    expect(r.stop).toBe('wall-time')
    expect(r.detail).toMatch(/wall time|time left/i)
    expect(r.detail).not.toMatch(/fully archived/)
  })

  it('reports a walk that ran to completion as walked, not as stopped', async () => {
    const d = deps({ spentBeforeWorkMs: 1_000 })

    const r = await runArchiveBacklog(d.injected)

    expect(r.stop).toBe('walked')
  })
})
