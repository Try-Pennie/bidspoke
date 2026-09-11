/**
 * How much room the archive has before its busiest hour no longer fits (#1294).
 *
 * THE LIMIT THAT ACTUALLY BINDS. The run loop reserves room for the hour it is
 * about to start, sized from the slowest hour it has already completed, so it
 * will not begin an hour it cannot finish. That is the right behaviour and it is
 * what stops a run overshooting into a platform kill. The consequence at the
 * ceiling is the problem: once the busiest hour no longer fits, the run archives
 * ZERO hours, completes cleanly, and writes a normal run record. A run that
 * archives nothing is indistinguishable from a run with nothing to do (L98). The
 * standstill detector does eventually catch it, three cadences later, and
 * reports a stall rather than the capacity problem it is.
 *
 * WHY THIS IS A LIVE READING AND NOT A TEST. `execution-archive.test.ts` fails
 * when the ratio drops below 1.25, which catches a change to the budget or the
 * cap. It cannot catch the direction this will actually come from: traffic
 * growing 32% touches no file in the repo, so nothing goes red while the margin
 * disappears (L336). This is computed from production's own run records, so it
 * moves when the business does.
 *
 * THE OTHER READING OF THE SAME MEASUREMENT is query 3 in
 * `supabase/tests/measure-archive-hour-cost.sql`, which is run by hand against
 * production. Two readings of one measurement have to be comparable field by
 * field, or a disagreement between them cannot be located (L58), so this reports
 * the same quantities in the same units: the busiest hour's executions, the p95
 * milliseconds per execution, the resulting cost, the wall budget, and the
 * ratio. If they disagree, the inputs say where.
 *
 * Measured 2026-09-10 over 163 single-hour runs: 48.4 ms per execution at the
 * mean, 60.8 at the p95, busiest hour 9,716 executions, about 591 seconds
 * against 780, a ratio of 1.32.
 */

/** One completed single-hour archive run, as its run record recorded it. */
export interface HourRun {
  executionsArchived: number
  durationMs: number
}

export type HeadroomReading =
  | {
      kind: 'measured'
      runsMeasured: number
      busiestHourExecutions: number
      p95MsPerExecution: number
      busiestHourCostMs: number
      wallBudgetMs: number
      /**
       * Wall budget divided by what the busiest hour costs.
       *
       * A RATIO rather than spare seconds, so it keeps its meaning when either
       * side moves. Below about 1.25 there is still room to act. Below 1.0 the
       * archive cannot advance at peak at all.
       */
      ratio: number
    }
  | { kind: 'too-few-runs'; runsMeasured: number; needed: number }

/**
 * Hours below this are all fixed overhead.
 *
 * A ten execution hour costing eight seconds reads as 800 ms per execution,
 * which is not a rate the archive has: it is the run's own setup divided by
 * almost nothing. Left in, it becomes the p95 and the whole reading is about
 * overhead rather than about archiving (L323). The same floor as the manual
 * query, so the two readings exclude the same runs.
 */
const MINIMUM_EXECUTIONS = 200

/**
 * Fewer samples than this and the percentile is a number with no meaning.
 *
 * Reported as "cannot measure" rather than as a ratio, because a headroom figure
 * is read as a measurement and one drawn from three runs would be acted on the
 * same way as one drawn from a hundred (L395, L656).
 */
const MINIMUM_RUNS = 5

/** The p95 of a list, by the same nearest-rank method the SQL percentile uses. */
function p95(sorted: number[]): number {
  if (sorted.length === 1) return sorted[0]
  // Linear interpolation between the two neighbouring ranks, which is what
  // Postgres `percentile_cont` does, so the two readings agree on a small
  // sample rather than only on a large one.
  const position = 0.95 * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function headroomFrom(runs: HourRun[], wallBudgetMs: number): HeadroomReading {
  const usable = runs.filter((r) => r.executionsArchived > MINIMUM_EXECUTIONS && r.durationMs > 0)
  if (usable.length < MINIMUM_RUNS) {
    return { kind: 'too-few-runs', runsMeasured: usable.length, needed: MINIMUM_RUNS }
  }

  const rates = usable.map((r) => r.durationMs / r.executionsArchived).sort((a, b) => a - b)
  const p95MsPerExecution = p95(rates)
  const busiestHourExecutions = Math.max(...usable.map((r) => r.executionsArchived))
  const busiestHourCostMs = busiestHourExecutions * p95MsPerExecution

  return {
    kind: 'measured',
    runsMeasured: usable.length,
    busiestHourExecutions,
    p95MsPerExecution: Math.round(p95MsPerExecution * 10) / 10,
    busiestHourCostMs: Math.round(busiestHourCostMs),
    wallBudgetMs,
    ratio: Math.round((wallBudgetMs / busiestHourCostMs) * 100) / 100,
  }
}
