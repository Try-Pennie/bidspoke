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

// ============================================================
// Paging, and the window a step fetch must cover
// ============================================================

/**
 * The worst gap ever observed between a step's own start and its execution's
 * start, measured on prod 2026-08-20 across 5 UTC days and 5,250,914 step rows
 * (per-day maxima 88.669, 35.372, 40.722, 45.198, 40.669 seconds). Nothing
 * exceeded 5 minutes and no step started before its execution.
 *
 * Recorded so the constant below can be checked against a number rather than
 * against a feeling.
 */
export const MEASURED_WORST_STEP_LAG_MS = 88_669

/**
 * How far past an hour's end the step fetch's partition hint reaches.
 *
 * Deliberately about 40x the worst observed lag. Too small silently DROPS
 * steps, which is unrecoverable once the source partition is purged; too large
 * only pulls in one more daily partition on a read that is already bounded by
 * execution_started_at. The asymmetry says pick generously.
 */
export const MAX_STEP_LAG_MS = 60 * 60 * 1000

export interface StepWindow {
  /** Correctness: which hour the step's EXECUTION belongs to. */
  executionStartedFrom: string
  executionStartedTo: string
  /** Partition pruning hint only, widened so late steps are not dropped. */
  stepStartedFrom: string
  stepStartedTo: string
}

/**
 * The predicates a step fetch for one hour must use.
 *
 * `execution_started_at` is the correctness bound: it is the same definition of
 * which hour a step belongs to that archiveDay uses for the day. `started_at`
 * is only a hint to keep the read inside a few daily partitions, and it MUST
 * reach past the hour end, because a step that began after its execution's hour
 * closed lives in the next partition. Bounding it at the hour end, or at the
 * last execution's start, silently stores a short bundle for every execution
 * near the end of the window.
 */
export function stepWindowFor(hourStart: string, hourEnd: string): StepWindow {
  return {
    executionStartedFrom: hourStart,
    executionStartedTo: hourEnd,
    stepStartedFrom: hourStart,
    stepStartedTo: new Date(Date.parse(hourEnd) + MAX_STEP_LAG_MS).toISOString(),
  }
}

export interface Page<T> {
  rows: T[]
  /** Set when the page could not be read. A partial collection is never a result. */
  error?: string
}

export type PagedFetch<T> =
  | { usable: true; rows: T[]; pages: number }
  | { usable: false; rows: []; pages: number; reason: string }

/**
 * Reads every page of a CURSOR-paged query and reconciles the total against an
 * independently sourced expectation.
 *
 * CURSOR, NOT OFFSET, and this is not a preference. Offset paging makes Postgres
 * walk and discard every row before the offset, so page cost grows linearly with
 * depth. Measured against production on 2026-08-20: reading one real hour of
 * steps (52,820 rows over 53 pages) failed at offset 48,000 with "canceling
 * statement due to statement timeout". Every run would have died there. Keyed on
 * the last row's id instead, each page costs the same regardless of depth.
 *
 * The reconciliation is the other half. PostgREST caps a response at 1,000 rows
 * whatever limit is asked for, and a short read is FASTER than a complete one,
 * so truncation presents as a performance win: measured in A0, a truncated 150
 * execution batch reported a 15.9x speedup against the correct run's 9x. Only an
 * expectation from somewhere else can tell the two apart (L98, L63).
 *
 * The caller must order the underlying query by the same unique column the
 * cursor is taken from, or rows repeat or vanish between pages.
 */
export async function fetchAllPages<T>(opts: {
  expected: number
  pageSize: number
  cursorOf: (row: T) => string
  fetchPage: (cursor: string | null, limit: number) => Promise<Page<T>>
}): Promise<PagedFetch<T>> {
  const { expected, pageSize, cursorOf, fetchPage } = opts

  if (pageSize > POSTGREST_ROW_CAP) {
    throw new Error(
      `page size ${pageSize} exceeds the ${POSTGREST_ROW_CAP} row cap, and asking for more returns the cap silently`,
    )
  }
  if (pageSize < 1) {
    throw new Error(`page size ${pageSize} would never make progress`)
  }

  // Zero expected is a real answer, not a failure, and it must not be reached by
  // reading a page: "found nothing" and "read nothing" are different (L98).
  if (expected === 0) return { usable: true, rows: [], pages: 0 }

  const rows: T[] = []
  let pages = 0
  let cursor: string | null = null

  // One page of slack past the expectation, so a table that grew between the
  // count and the read is DETECTED rather than read forever on a fixed budget.
  const maxPages = Math.ceil(expected / pageSize) + 1

  while (pages < maxPages) {
    const page: Page<T> = await fetchPage(cursor, pageSize)
    pages++

    if (page.error !== undefined) {
      return {
        usable: false,
        rows: [],
        pages,
        reason: `page ${pages} failed: ${page.error}`,
      }
    }

    rows.push(...page.rows)

    if (rows.length > expected) {
      return {
        usable: false,
        rows: [],
        pages,
        reason: `more rows arrived than expected: ${rows.length} against ${expected}, so the source changed mid-read`,
      }
    }
    if (page.rows.length < pageSize) break

    // Without a usable cursor the next request repeats this page forever, so
    // refusing names the cause rather than hanging (L110).
    const last = page.rows[page.rows.length - 1]
    const next = cursorOf(last)
    if (typeof next !== 'string' || next.length === 0) {
      return {
        usable: false,
        rows: [],
        pages,
        reason: `page ${pages} ended with a row carrying no cursor, so paging cannot advance`,
      }
    }
    cursor = next
  }

  const assessment = assessBatch({ rowsExpected: expected, rowsReturned: rows.length })
  if (!assessment.usable) {
    return { usable: false, rows: [], pages, reason: assessment.reason ?? 'the batch did not reconcile' }
  }

  return { usable: true, rows, pages }
}
