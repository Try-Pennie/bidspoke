/**
 * Reads one closed UTC hour in SLICES, so peak memory does not scale with the
 * hour (#953, replacing the whole-hour read from #871).
 *
 * WHY THIS SHAPE. Measured on prod 2026-08-22 with `scripts/dry-run-archive.ts`,
 * one hour of 2,615 executions holds 183.5 MB of raw rows and 33.8 MB of encoded
 * wires, both alive at once during encoding, against Cloudflare's 128 MB
 * ceiling. The 16:23 UTC run was killed with outcome `exceededMemory` at 9.4 s
 * of CPU against a 30,000 ms allowance, and every run after it died identically,
 * because a killed run never advances the watermark and so retries the same
 * oversized work forever.
 *
 * The previous version's per-run hour cap was justified in a comment against
 * CPU. That was reasoning about the limit that was never going to bind, and the
 * number it produced looked measured. No cap value fixes it either: a single
 * busy hour exceeds the ceiling on its own, so the unit of work has to be
 * smaller than an hour.
 *
 * The two measured facts from A0 that shaped the old version still hold and are
 * still honoured here:
 *
 * 1. One step query per execution costs 138 ms and batched it is 15.4 ms, so
 *    steps are still read in batches, just per slice instead of per hour.
 * 2. PostgREST caps a response at 1,000 rows whatever limit is asked for, and a
 *    truncated read is FASTER, so truncation presents as a performance win.
 *    Every read still pages, and the hour is still reconciled against
 *    independently counted expectations before it can be called usable.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { groupStepsByExecution, stepWindowFor, POSTGREST_ROW_CAP } from './fetch'

/**
 * Executions per slice.
 *
 * Derived from the measured WORST WINDOW, not from the mean, because the sizes
 * are heavily skewed and a mean would justify a number the tail can break.
 * Measured on prod 2026-08-22 over the 13:00 UTC hour (3,575 executions):
 *
 *   heaviest slice of 150 consecutive executions   14.1 MB
 *   heaviest single execution                       2.0 MB
 *   median wire                                     7.5 kB
 *   largest wire                                  218   kB
 *
 * So 150 leaves roughly a 9x margin against the worst slice that hour actually
 * contained. It does NOT leave a margin against a hypothetical slice of 150
 * heaviest-case executions, which would be 304 MB: a count-based cap cannot,
 * because the count says nothing about the bytes. That residual is recorded
 * rather than papered over, and the byte-aware fix is its own change.
 *
 * Not larger, because the slice's step ids travel in the URL (see
 * MAX_ID_LIST_CHARS). Not smaller, because each slice costs a fixed handful of
 * subrequests and the run's allowance is what limits how many hours a run can
 * catch up: at 150 an hour costs about 90 requests of the 900 available.
 *
 * Not larger, because the slice's step ids travel in the URL (see
 * MAX_ID_LIST_CHARS). Not smaller, because each slice costs a fixed handful of
 * subrequests and the run's allowance is what limits how many hours a run can
 * catch up.
 */
export const SLICE_SIZE = 150

/**
 * Ceiling on the id list a slice may put in one URL.
 *
 * The one new failure mode this shape introduces. A slice size that outgrew the
 * URL limit would have its filter silently rejected or truncated, and a
 * truncated filter returns FEWER steps, which reconciles short and refuses the
 * hour for a reason that names counting rather than the URL. So the size is
 * asserted against this rather than trusted, and a violation throws.
 */
export const MAX_ID_LIST_CHARS = 8000

/** One page below the cap, so a full page is never ambiguous with a capped one. */
const PAGE_SIZE = POSTGREST_ROW_CAP

export interface HourBundle {
  executionId: string
  execution: Record<string, unknown>
  steps: Record<string, unknown>[]
}

export type HourStream =
  | {
      usable: true
      empty: boolean
      executionCount: number
      stepCount: number
      /** Requests actually made, counted rather than estimated (L182). */
      requests: number
    }
  | { usable: false; reason: string; requests: number }

interface CountResult {
  count: number | null
  error: unknown
}

async function countRows(
  build: () => PromiseLike<CountResult>,
  what: string,
): Promise<{ count: number } | { error: string }> {
  const { count, error } = await build()
  if (error) return { error: `counting ${what} failed: ${JSON.stringify(error)}` }
  // A null count is not zero. PostgREST omits it when the header is absent, and
  // reading that as "no rows" would make every hour archive nothing and report
  // success (L90).
  if (count === null || count === undefined) {
    return { error: `counting ${what} returned no count, which is not the same as no rows` }
  }
  return { count }
}

/**
 * Reads the hour, handing the caller one slice at a time.
 *
 * `onSlice` is awaited before the next slice is read, which is the whole point:
 * the previous slice is unreachable by the time the next one exists. An error
 * thrown by `onSlice` propagates, because a failed send must stop the hour
 * rather than be recorded as a read problem.
 */
export async function streamHour(
  supabase: SupabaseClient,
  hourStart: string,
  hourEnd: string,
  onSlice: (bundles: HourBundle[]) => Promise<void>,
): Promise<HourStream> {
  const window = stepWindowFor(hourStart, hourEnd)
  let requests = 0

  requests++
  const executionCount = await countRows(
    () =>
      supabase
        .from('workflow_executions')
        .select('id', { count: 'exact', head: true })
        .gte('started_at', hourStart)
        .lt('started_at', hourEnd),
    'executions',
  )
  if ('error' in executionCount) return { usable: false, reason: executionCount.error, requests }

  // An hour with no executions is a real answer with its own wording, and it
  // must not go on to read steps: "found nothing" and "read nothing" are
  // different outcomes and must not be reported the same way (L98).
  if (executionCount.count === 0) {
    return { usable: true, empty: true, executionCount: 0, stepCount: 0, requests }
  }

  requests++
  const stepCount = await countRows(
    () =>
      supabase
        .from('execution_steps')
        .select('id', { count: 'exact', head: true })
        .gte('execution_started_at', window.executionStartedFrom)
        .lt('execution_started_at', window.executionStartedTo)
        .gte('started_at', window.stepStartedFrom)
        .lt('started_at', window.stepStartedTo),
    'steps',
  )
  if ('error' in stepCount) return { usable: false, reason: stepCount.error, requests }

  let executionsRead = 0
  let stepsRead = 0
  let cursor: string | null = null

  // One slice of slack past the expectation, so a table that grew between the
  // count and the read is DETECTED rather than read forever on a fixed budget.
  const maxSlices = Math.ceil(executionCount.count / SLICE_SIZE) + 1

  for (let slice = 0; slice < maxSlices; slice++) {
    requests++
    let q = supabase
      .from('workflow_executions')
      .select('*')
      .gte('started_at', hourStart)
      .lt('started_at', hourEnd)
      // Ordered by the primary key, which is unique and is what the cursor is
      // taken from. Paging over an unordered result is undefined: rows repeat or
      // vanish between pages.
      .order('id')
      .limit(SLICE_SIZE)
    if (cursor !== null) q = q.gt('id', cursor)
    const { data, error } = (await q) as unknown as { data: Record<string, unknown>[] | null; error: unknown }
    if (error) return { usable: false, reason: `executions slice ${slice + 1}: ${JSON.stringify(error)}`, requests }

    const rows = data ?? []
    if (rows.length === 0) break

    const ids: string[] = []
    for (const row of rows) {
      const id = row.id
      if (typeof id !== 'string' || id.length === 0) {
        return { usable: false, reason: 'an execution row came back with no id, so it cannot be bundled', requests }
      }
      ids.push(id)
    }

    // Asserted, not assumed. A list that outgrew the URL would come back short
    // and be reported as a counting problem several steps later.
    const listChars = ids.reduce((n, id) => n + id.length + 3, 0)
    if (listChars > MAX_ID_LIST_CHARS) {
      return {
        usable: false,
        reason: `a slice of ${ids.length} ids needs ${listChars} URL characters, over the ${MAX_ID_LIST_CHARS} limit`,
        requests,
      }
    }

    const steps: Record<string, unknown>[] = []
    let stepCursor: string | null = null
    // Bounded rather than while(true): a slice of SLICE_SIZE executions cannot
    // legitimately need many pages, and a loop with no bound cannot fail, only
    // hang (L110).
    const maxStepPages = Math.ceil((SLICE_SIZE * 200) / PAGE_SIZE) + 1
    for (let page = 0; page < maxStepPages; page++) {
      requests++
      let sq = supabase
        .from('execution_steps')
        .select('*')
        // The correctness bound is the id list. The window predicates stay
        // because they are what prunes partitions: the id list alone would scan
        // every partition the table has.
        .in('execution_id', ids)
        .gte('execution_started_at', window.executionStartedFrom)
        .lt('execution_started_at', window.executionStartedTo)
        .gte('started_at', window.stepStartedFrom)
        .lt('started_at', window.stepStartedTo)
        .order('id')
        .limit(PAGE_SIZE)
      if (stepCursor !== null) sq = sq.gt('id', stepCursor)
      const res = (await sq) as unknown as { data: Record<string, unknown>[] | null; error: unknown }
      if (res.error) {
        return { usable: false, reason: `steps for slice ${slice + 1}: ${JSON.stringify(res.error)}`, requests }
      }
      const page_rows = res.data ?? []
      steps.push(...page_rows)
      if (page_rows.length < PAGE_SIZE) break
      const last = page_rows[page_rows.length - 1].id
      if (typeof last !== 'string' || last.length === 0) {
        return { usable: false, reason: 'a step row came back with no id, so the page cannot be continued', requests }
      }
      stepCursor = last
    }

    const byExecution = groupStepsByExecution(steps)
    const bundles: HourBundle[] = rows.map((execution, i) => ({
      executionId: ids[i],
      execution,
      // An execution that failed before its first step logged has none, and it
      // is still archived: dropping it leaves the deletion gate one short with
      // nothing explaining the difference.
      steps: byExecution.get(ids[i]) ?? [],
    }))

    executionsRead += bundles.length
    stepsRead += steps.length
    cursor = ids[ids.length - 1]

    await onSlice(bundles)

    if (rows.length < SLICE_SIZE) break
  }

  // Reconciled AFTER the slices have been handed over, which is a deliberate
  // difference from the whole-hour version. A mismatch still refuses the hour,
  // so the watermark does not advance and the hour is read again; what has
  // already been sent is re-sent, which the gate's COUNT(DISTINCT) tolerates by
  // design. The alternative, holding everything back until the counts agree, is
  // the shape that ran out of memory.
  if (executionsRead !== executionCount.count) {
    return {
      usable: false,
      reason: `executions read do not match the count: ${executionsRead} against ${executionCount.count}`,
      requests,
    }
  }
  if (stepsRead !== stepCount.count) {
    return {
      usable: false,
      reason: `steps read do not match the count: ${stepsRead} against ${stepCount.count}`,
      requests,
    }
  }

  return { usable: true, empty: false, executionCount: executionsRead, stepCount: stepsRead, requests }
}
