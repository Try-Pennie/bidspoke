/**
 * The archive's headroom, as a live number rather than a constant (#1294).
 *
 * Measured 2026-09-10 over 163 single-hour runs: cost is linear in volume at
 * 48.4 ms per execution at the mean and 60.8 at the p95, and the busiest single
 * hour held 9,716 executions. That is about 591 seconds against a 780 second
 * wall budget, a ratio of 1.32.
 *
 * Once the busiest hour no longer fits, the run reserves room it cannot find and
 * archives ZERO hours. It completes cleanly and writes a normal run record, and
 * a run that archives nothing is indistinguishable from a run with nothing to do
 * (L98). The standstill detector catches it three cadences later, as a stall
 * rather than as the capacity problem it is.
 *
 * A test in the worker already fails if the ratio drops below 1.25, but it
 * guards OUR CONSTANTS against our own edits. Traffic growing 32% touches no
 * file, so nothing goes red, and growth is the direction this will actually come
 * from (L336). Hence a reading taken from production's own run records.
 */
import { describe, it, expect } from 'vitest'
import { headroomFrom, type HourRun } from '../headroom'

const WALL_MS = 780_000

/** n runs of the same shape, so the percentile has something to sit in. */
const runs = (specs: Array<[execs: number, ms: number]>): HourRun[] =>
  specs.map(([executionsArchived, durationMs]) => ({ executionsArchived, durationMs }))

describe('headroomFrom', () => {
  it('prices the busiest hour at the p95 rate, not at the mean', () => {
    // The mean flatters it. What decides whether a run can finish is a bad hour
    // at a bad rate, and the two are not independent.
    const reading = headroomFrom(
      runs([
        [1_000, 40_000],
        [1_000, 40_000],
        [1_000, 40_000],
        [1_000, 40_000],
        [1_000, 40_000],
        [9_716, 590_000],
      ]),
      WALL_MS,
    )

    expect(reading.kind).toBe('measured')
    if (reading.kind !== 'measured') return
    expect(reading.busiestHourExecutions).toBe(9_716)
    // 9,716 at the p95 rate of ~60.7 ms is ~590s against 780s.
    expect(reading.busiestHourCostMs).toBeGreaterThan(500_000)
    expect(reading.ratio).toBeGreaterThan(1.2)
    expect(reading.ratio).toBeLessThan(1.6)
  })

  it('falls below one when the busiest hour no longer fits', () => {
    const reading = headroomFrom(
      runs([
        [20_000, 1_300_000],
        [1_000, 65_000],
        [1_000, 65_000],
        [1_000, 65_000],
        [1_000, 65_000],
        [1_000, 65_000],
      ]),
      WALL_MS,
    )

    expect(reading.kind).toBe('measured')
    if (reading.kind !== 'measured') return
    expect(reading.ratio).toBeLessThan(1)
  })

  it('ignores near-empty hours, whose per-execution rate is all fixed overhead', () => {
    // A ten execution hour costing eight seconds reads as 800 ms per execution,
    // which is not a rate the archive has: it is the run's own setup. Left in,
    // it becomes the p95 and the whole reading is about overhead (L323).
    const real: Array<[number, number]> = [
      [1_000, 40_000],
      [1_000, 41_000],
      [1_000, 42_000],
      [1_200, 50_000],
      [5_000, 210_000],
    ]
    const withNoise = headroomFrom(runs([[10, 8_000], ...real]), WALL_MS)
    const without = headroomFrom(runs(real), WALL_MS)

    expect(withNoise).toEqual(without)
  })

  it('refuses to report a ratio it has too few runs to support', () => {
    // A percentile over three samples is a number with no meaning, and a
    // headroom figure is read as a measurement (L395, L656). Saying it cannot
    // measure is the honest answer and it is distinguishable from a bad ratio.
    const reading = headroomFrom(runs([[1_000, 40_000], [1_000, 41_000], [1_000, 42_000]]), WALL_MS)

    expect(reading.kind).toBe('too-few-runs')
  })

  it('refuses on an empty history rather than reporting infinite headroom', () => {
    // Dividing by nothing is how a check with no data reports the healthiest
    // possible answer (L98).
    const reading = headroomFrom([], WALL_MS)

    expect(reading.kind).toBe('too-few-runs')
  })

  it('says how many runs it measured, so the reading can be judged', () => {
    const reading = headroomFrom(
      runs([[1_000, 40_000], [1_100, 44_000], [1_200, 48_000], [2_000, 80_000], [9_000, 400_000]]),
      WALL_MS,
    )

    expect(reading.kind).toBe('measured')
    if (reading.kind !== 'measured') return
    expect(reading.runsMeasured).toBe(5)
  })

  it('reports the same figures the manual query prints, in the same units', () => {
    // The SQL in supabase/tests/measure-archive-hour-cost.sql is the other
    // reading of this, and two readings of one measurement have to be
    // comparable field by field or a disagreement cannot be located (L58).
    const reading = headroomFrom(
      runs([[1_000, 40_000], [1_100, 44_000], [1_200, 48_000], [2_000, 80_000], [9_716, 590_000]]),
      WALL_MS,
    )

    expect(reading.kind).toBe('measured')
    if (reading.kind !== 'measured') return
    expect(Object.keys(reading).sort()).toEqual(
      ['busiestHourCostMs', 'busiestHourExecutions', 'kind', 'p95MsPerExecution', 'ratio', 'runsMeasured', 'wallBudgetMs'].sort(),
    )
  })
})
