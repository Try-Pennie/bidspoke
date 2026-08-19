// Batched step fetching for the archive.
//
// Measured on prod 2026-08-19: fetching steps one query per execution costs
// 138 ms each, which is about ten minutes of an hourly run's twelve minute
// budget spent fetching. Batched per day partition it is 15.4 ms, nine times
// faster. So the archiver batches.
//
// The catch is that a batch can come back short, and short reads FASTER. The
// truncated 150-execution measurement reported a better speedup than the
// correct one precisely because it fetched less, so a batch is not usable until
// its row count has been reconciled against an independent expectation.

/** PostgREST caps a response at 1,000 rows regardless of a higher .limit(). */
export const POSTGREST_ROW_CAP = 1000

export interface BatchAssessment {
  truncated: boolean
  agree: boolean
  /** False means the batch must not be used to build bundles. */
  usable: boolean
  reason?: string
}

export function assessBatch(counts: { rowsExpected: number; rowsReturned: number }): BatchAssessment {
  const { rowsExpected, rowsReturned } = counts
  const truncated = rowsReturned >= POSTGREST_ROW_CAP
  const agree = rowsReturned === rowsExpected

  if (truncated && !agree) {
    return {
      truncated,
      agree,
      usable: false,
      reason: `batch hit the ${POSTGREST_ROW_CAP} row cap: expected ${rowsExpected}, got ${rowsReturned}. Page the fetch.`,
    }
  }
  if (!agree) {
    return {
      truncated,
      agree,
      usable: false,
      reason: `batch returned fewer rows than expected: ${rowsReturned} against ${rowsExpected}`,
    }
  }
  return { truncated, agree, usable: true }
}

export function groupStepsByExecution<T extends Record<string, unknown>>(steps: T[]): Map<string, T[]> {
  const byExecution = new Map<string, T[]>()
  for (const step of steps) {
    const key = step.execution_id
    if (typeof key !== 'string' || key.length === 0) {
      // Dropping it would produce a short bundle, which is the one failure the
      // deletion gate cannot distinguish from a correct one.
      throw new Error('step row has no execution_id, so it cannot be placed in a bundle')
    }
    const list = byExecution.get(key)
    if (list) list.push(step)
    else byExecution.set(key, [step])
  }
  return byExecution
}
