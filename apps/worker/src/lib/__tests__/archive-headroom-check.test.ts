/**
 * The headroom speaks for itself rather than waiting to be read (#1294).
 *
 * Publishing the ratio in the health report makes it visible to somebody who
 * opens the report. A counter that renders its number on a screen is not a
 * detector, because detection requires something that speaks on its own when the
 * number is wrong (L357), and the issue's own argument was that none of the ways
 * to raise the ceiling help if nobody notices the day the headroom is gone.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkArchiveHeadroom,
  ARCHIVE_HEADROOM_JOB,
  ARCHIVE_HEADROOM_FLOOR,
} from '../archive-headroom-check'
import { CRON_RUN_BUDGET } from '../../archive/deadline'
import type { HourRun } from '../../archive/headroom'

const supabase = {} as unknown as SupabaseClient
const env = { IDEMPOTENCY: {} } as never

function notifier() {
  const calls: Array<{ job: string; errors: string[] }> = []
  return {
    calls,
    notify: vi.fn(async (_s: unknown, job: string, errors: string[]) => {
      calls.push({ job, errors })
    }),
  }
}

/**
 * Runs whose busiest hour costs `ratio` of the wall budget.
 *
 * Derived from the budget rather than written as a duration, so a change to the
 * budget moves the fixture with it instead of quietly changing what is tested
 * (L401).
 */
function runsAtRatio(ratio: number): HourRun[] {
  const busiestCostMs = CRON_RUN_BUDGET.wallMs / ratio
  const executions = 10_000
  const filler: HourRun[] = Array.from({ length: 8 }, () => ({
    executionsArchived: 1_000,
    durationMs: (busiestCostMs / executions) * 1_000,
  }))
  return [...filler, { executionsArchived: executions, durationMs: busiestCostMs }]
}

describe('checkArchiveHeadroom', () => {
  it('speaks when the ratio is under the floor', async () => {
    const n = notifier()

    const r = await checkArchiveHeadroom(env, supabase, {
      readRuns: async () => runsAtRatio(ARCHIVE_HEADROOM_FLOOR - 0.1),
      notify: n.notify as never,
    })

    expect(r.alerted).toBe(true)
    expect(n.calls).toHaveLength(1)
    expect(n.calls[0].job).toBe(ARCHIVE_HEADROOM_JOB)
    expect(n.calls[0].errors).toHaveLength(1)
  })

  it('names the figures it measured, so the alert can be acted on', async () => {
    const n = notifier()

    await checkArchiveHeadroom(env, supabase, {
      readRuns: async () => runsAtRatio(1.0),
      notify: n.notify as never,
    })

    const said = n.calls[0].errors[0]
    // A bare "headroom is low" points nowhere. The busiest hour, the rate and
    // the budget are what say which of the four remedies applies (L11).
    expect(said).toMatch(/10,000 executions/)
    expect(said).toMatch(/wall\s*\n?\s*budget|wall budget/)
    expect(said).toMatch(/ratio of/)
    expect(said).toMatch(/single-hour runs/)
  })

  it('stays quiet, and clears, when there is room', async () => {
    const n = notifier()

    const r = await checkArchiveHeadroom(env, supabase, {
      readRuns: async () => runsAtRatio(ARCHIVE_HEADROOM_FLOOR + 0.5),
      notify: n.notify as never,
    })

    expect(r.alerted).toBe(false)
    // Called with NO errors rather than not called: that is what clears a
    // standing alert, so a recovered headroom stops announcing itself and a
    // later dip is announced again rather than suppressed by the old one.
    expect(n.calls).toHaveLength(1)
    expect(n.calls[0].errors).toEqual([])
  })

  it('does not alert when it could not take a reading', async () => {
    // Too few runs means the archive has barely run, which the cron heartbeat
    // and the standstill detector both already report. A second name for a
    // condition that already has one is how a pair of alerts teaches people to
    // ignore both (L11), and it would fire on every fresh environment.
    const n = notifier()

    const r = await checkArchiveHeadroom(env, supabase, {
      readRuns: async () => [],
      notify: n.notify as never,
    })

    expect(r.reading.kind).toBe('too-few-runs')
    expect(r.alerted).toBe(false)
    expect(n.calls[0].errors).toEqual([])
  })

  it('fails loudly when it cannot read the runs, rather than reporting room', async () => {
    // The dangerous outcome. A read that throws must not be caught into a
    // quiet "no alert", because an all-clear and a check that never ran look
    // identical from outside and the second is the one that lasts (L98, L10).
    // It surfaces instead, and the daily batch logs it as this check failing.
    const n = notifier()

    await expect(
      checkArchiveHeadroom(env, supabase, {
        readRuns: async () => {
          throw new Error('statement timeout reading job_runs')
        },
        notify: n.notify as never,
      }),
    ).rejects.toThrow(/statement timeout/)

    // And nothing was announced either way: it has no reading to announce.
    expect(n.calls).toEqual([])
  })

  it('does not swallow a failure to deliver the alert', async () => {
    // A check that decided to speak and could not must not return as though it
    // had. The condition then goes unannounced AND unrecorded, which is the
    // worse of the two (L71: the report must not quietly share the fate of
    // what it reports on).
    const n = notifier()
    n.notify.mockRejectedValueOnce(new Error('slack is down'))

    await expect(
      checkArchiveHeadroom(env, supabase, {
        readRuns: async () => runsAtRatio(1.0),
        notify: n.notify as never,
      }),
    ).rejects.toThrow(/slack is down/)
  })

  it('watches the same number the CI test watches', () => {
    // Two thresholds for one condition drift apart, and the drift is silent
    // because each is right on its own terms (L70). This one catches the
    // traffic growing; the test catches a change to our constants.
    expect(ARCHIVE_HEADROOM_FLOOR).toBe(1.25)
  })
})
