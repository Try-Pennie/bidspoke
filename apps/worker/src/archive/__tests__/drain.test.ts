import { describe, it, expect } from 'vitest'
import { runArchive, type RunDeps, type EncodedForSend } from '../run-loop'
import { CRON_RUN_BUDGET } from '../deadline'
import type { HourBundle, HourStream } from '../stream-hour'

/**
 * THE DRAIN TEST (#876, Phase A8).
 *
 * The question A8 exists to answer, before either destructive job is allowed to
 * depend on the archive: stop the archiver for three days, start it again, and
 * does it ever catch up?
 *
 * WHY IT CANNOT BE ANSWERED BY WATCHING PRODUCTION. Measured 2026-09-10 over
 * 21 days of `job_runs`: since 2026-08-27 the archive has run exactly 24 times a
 * day, archived exactly 24 hours a day, and reported `hoursBehind` of 0 on every
 * single run. It has never been behind. So the entire catch-up mechanism, the
 * multi-hour loop and the overshoot reserve, has never once executed in
 * production, and code that has never run is not code anybody has evidence
 * about (L535). Waiting for a real backlog is waiting for the incident this is
 * supposed to be ready for.
 *
 * And it must not be produced by stopping the real archiver: the deletion gate
 * reads what the archive recorded, so a deliberate three day gap on production
 * is a deliberate three day hold on the thing that protects the partitions.
 *
 * So the backlog is synthetic and the ARCHIVER IS REAL. This drives the actual
 * `runArchive`, with its actual budget, its actual readiness rule and its actual
 * reserve. Only the cost of doing the work is simulated, and it is simulated
 * from measurement rather than invention.
 *
 * WHAT IS MEASURED, from 163 single-hour production runs in the 7 days to
 * 2026-09-10 (re-take with supabase/tests/measure-archive-hour-cost.sql):
 *
 *   an hour costs 48.4 ms per execution at the mean, 60.8 at the p95
 *   the hourly volume curve below, by UTC hour, is that week's mean
 *   cost is linear in volume, correlation 0.937, which is what licenses
 *     pricing a simulated hour by multiplying the two
 *
 * The clock only ever moves FORWARD by the cost of work actually done, so a run
 * that does nothing takes no time and cannot loop for ever unnoticed.
 */

const HOUR_MS = 60 * 60 * 1000

/**
 * Executions per hour, by UTC hour, measured as that week's mean.
 *
 * The SHAPE is the point, not the totals. A flat curve would make every hour
 * cost the same and the run would archive the same number every time, which is
 * the one thing production never does: the busiest hour is six times the
 * quietest, so a drain that starts in the evening behaves quite differently
 * from one that starts at dawn.
 */
const EXECUTIONS_BY_UTC_HOUR = [
  5991, 5183, 4369, 3792, 3470, 3164, 2766, 2384,
  1692, 1406, 1185, 1080, 1136, 1546, 2074, 2939,
  4544, 5357, 5805, 6187, 6192, 6255, 6012, 6116,
]

/** The p95 rate, so the drain is judged on a bad week rather than an average one. */
const MS_PER_EXECUTION = 60.8

/** Steps per execution, from the same measurement window. Only shapes counts. */
const STEPS_PER_EXECUTION = 11.9

interface DrainReport {
  runs: number
  hoursArchived: number
  /** Simulated wall time from the first run starting to the backlog clearing. */
  elapsedMs: number
  /** What stopped each run, in order. */
  stops: string[]
  /** Hours archived per run, in order. */
  perRun: number[]
}

/**
 * Runs the REAL archiver against a synthetic backlog until it is caught up.
 *
 * `maxRuns` is a refusal, not a tuning knob: a drain that has not finished by
 * then is the finding, and the test says so rather than hanging (L110).
 */
async function drain(opts: {
  backlogHours: number
  startAt: string
  budget: { wallMs: number; maxHours: number }
  maxRuns?: number
}): Promise<DrainReport> {
  const maxRuns = opts.maxRuns ?? 500

  // The archive is `backlogHours` behind: the watermark sits that far before
  // the newest hour that is closed and settled.
  const startMs = Date.parse(opts.startAt)
  let nowMs = startMs
  let watermark = new Date(startMs - (opts.backlogHours + 2) * HOUR_MS).toISOString()

  const report: DrainReport = { runs: 0, hoursArchived: 0, elapsedMs: 0, stops: [], perRun: [] }

  for (;;) {
    if (report.runs >= maxRuns) break

    const runStartedAt = nowMs
    let subrequests = 900

    const deps: RunDeps = {
      now: () => new Date(nowMs),
      readWatermark: async () => watermark,
      advanceWatermark: async (hourStart) => {
        watermark = hourStart
      },
      recordHour: async () => {},
      streamHour: async (hourStart, _hourEnd, onSlice) => {
        const utcHour = new Date(Date.parse(hourStart)).getUTCHours()
        const executions = EXECUTIONS_BY_UTC_HOUR[utcHour]

        // THE COST OF THE HOUR, charged to the clock. This is the whole
        // simulation: everything else here is the real code.
        nowMs += Math.round(executions * MS_PER_EXECUTION)
        subrequests -= Math.ceil((executions / 150) * 2)

        // One slice, because slicing is a memory concern and this test is about
        // time. The bundles are empty of content for the same reason.
        await onSlice([])

        return {
          usable: true,
          empty: false,
          executionCount: executions,
          stepCount: Math.round(executions * STEPS_PER_EXECUTION),
        } as HourStream
      },
      encode: async (bundle: HourBundle) =>
        ({ executionId: bundle.executionId, wire: '', bytes: 0, stepCount: 0 }) as unknown as EncodedForSend,
      send: async () => {},
      recordArchived: async () => {},
      recordRefusal: async () => {},
      budget: {
        maxHours: opts.budget.maxHours,
        deadlineAt: runStartedAt + opts.budget.wallMs,
        subrequestsLeft: () => subrequests,
      },
    }

    const result = await runArchive(deps)
    report.runs++
    report.stops.push(result.stop)
    report.perRun.push(result.hoursArchived)
    report.hoursArchived += result.hoursArchived

    if (result.stop === 'caught-up') {
      report.elapsedMs = nowMs - startMs
      return report
    }

    // The cron is hourly, so the next run starts at the next hour boundary and
    // never sooner. A run that overran its own hour does NOT get to start
    // immediately, which is what makes the drain rate honest.
    const nextFiring = runStartedAt + HOUR_MS
    nowMs = Math.max(nowMs, nextFiring)
  }

  report.elapsedMs = nowMs - startMs
  return report
}

describe('the archive drains a three day backlog (#876, Phase A8)', () => {
  // Starting in the EVENING, deliberately: the drain then begins with the
  // day's most expensive hours, which is both the worst case and the likeliest
  // one, since an outage noticed during the working day is restarted during it.
  const EVENING_START = '2026-09-10T20:00:00.000Z'
  const THREE_DAYS = 72

  it('clears three days rather than holding station for ever', async () => {
    const report = await drain({
      backlogHours: THREE_DAYS,
      startAt: EVENING_START,
      budget: { wallMs: CRON_RUN_BUDGET.wallMs, maxHours: CRON_RUN_BUDGET.maxHours },
    })

    // The A8 question, answered directly. Anything that did not reach
    // `caught-up` means the archive cannot recover from a three day outage on
    // its own, which is a cadence or batching fault to learn now (#876).
    expect(report.stops.at(-1), `drain stalled after ${report.runs} runs`).toBe('caught-up')
    expect(report.hoursArchived).toBeGreaterThanOrEqual(THREE_DAYS)
  })

  it('takes fewer runs than the backlog it is clearing, or it is not catching up', async () => {
    const report = await drain({
      backlogHours: THREE_DAYS,
      startAt: EVENING_START,
      budget: { wallMs: CRON_RUN_BUDGET.wallMs, maxHours: CRON_RUN_BUDGET.maxHours },
    })

    // One hour per run is the failure mode this whole change exists to escape:
    // the cron is hourly, so at one hour per run the archive gains nothing and
    // a backlog is permanent. Strictly fewer runs than hours is the definition
    // of gaining ground.
    expect(report.runs).toBeLessThan(THREE_DAYS)
  })

  // THE FIGURES, so a promise about a drain time can be checked rather than
  // guessed. Bounds rather than exact numbers, because the rate depends on
  // which hours of the day the drain passes through and an exact figure would
  // be a fixture pretending to be a law. Both starts are run, since the shape
  // of the day means an evening outage and a dawn one are different problems.
  const CASES = [
    { backlog: 24, start: EVENING_START, atMost: 20 },
    { backlog: 24, start: '2026-09-10T08:00:00.000Z', atMost: 20 },
    { backlog: THREE_DAYS, start: EVENING_START, atMost: 52 },
    { backlog: THREE_DAYS, start: '2026-09-10T08:00:00.000Z', atMost: 52 },
  ]

  for (const c of CASES) {
    it(`clears ${c.backlog}h of backlog from ${c.start.slice(11, 16)} inside ${c.atMost}h`, async () => {
      const report = await drain({
        backlogHours: c.backlog,
        startAt: c.start,
        budget: { wallMs: CRON_RUN_BUDGET.wallMs, maxHours: CRON_RUN_BUDGET.maxHours },
      })

      const hours = report.elapsedMs / HOUR_MS
      expect(report.stops.at(-1)).toBe('caught-up')
      // Measured 2026-09-10: 15 to 16 hours for a day, 46 for three days. The
      // bound carries headroom over that, so an ordinary cost drift does not
      // fail it while a change of KIND does.
      expect(hours).toBeLessThanOrEqual(c.atMost)
      // A drain cannot beat the backlog itself: it has to archive the accruing
      // hours too. This end catches a harness that stopped measuring.
      expect(hours).toBeGreaterThan(c.backlog / 3)
    })
  }

  it('drains roughly three times faster than the budget it replaced', async () => {
    // The comparison that justifies #1041, RUN rather than asserted, and it
    // corrects the claim that motivated the change. The old cap of 2 did catch
    // up: at a quiet hour it archived 2 while 1 accrued, so it gained ground,
    // just slowly. Saying it could "never" recover was wrong, and the honest
    // case is the ratio, which is large enough not to need overstating.
    const now = await drain({
      backlogHours: THREE_DAYS,
      startAt: EVENING_START,
      budget: { wallMs: CRON_RUN_BUDGET.wallMs, maxHours: CRON_RUN_BUDGET.maxHours },
    })
    const before = await drain({
      backlogHours: THREE_DAYS,
      startAt: EVENING_START,
      budget: { wallMs: 10 * 60 * 1000, maxHours: 2 },
      maxRuns: 400,
    })

    // Measured 2026-09-10: 47 runs against 142.
    expect(before.stops.at(-1)).toBe('caught-up')
    expect(before.runs / now.runs).toBeGreaterThan(2.5)
  })

  it('starts the backlog behind, so the drain is not measuring an empty queue', async () => {
    // Guards the harness itself: a backlog that was never actually behind would
    // report `caught-up` on run one and every assertion above would pass while
    // measuring nothing (L98, L159).
    const report = await drain({
      backlogHours: THREE_DAYS,
      startAt: EVENING_START,
      budget: { wallMs: CRON_RUN_BUDGET.wallMs, maxHours: CRON_RUN_BUDGET.maxHours },
    })

    expect(report.runs).toBeGreaterThan(1)
    expect(report.perRun[0]).toBeGreaterThan(0)
  })
})
