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
 * The largest page of executions the reader will ask for.
 *
 * A COUNT, and a count says nothing about bytes, which is what the 128 MB
 * isolate actually constrains. Measured on prod 2026-08-22 over the 13:00 UTC
 * hour (3,575 executions):
 *
 *   heaviest window of 150 consecutive executions   14.1 MB
 *   heaviest single execution                        2.0 MB
 *   median wire                                      7.5 kB
 *   largest wire                                   218   kB
 *
 * So 150 leaves roughly a 9x margin against the worst window that hour actually
 * contained, and NO margin at all against 150 of the heaviest: that page would
 * be 304 MB and would be killed exactly as the whole-hour reader was. The
 * distribution is fat tailed, and the margin rests entirely on the tail not
 * clustering, which is the kind of assumption this milestone keeps finding to be
 * wrong (#983).
 *
 * So this is now a CEILING on an adaptive page rather than the page itself. See
 * TARGET_SLICE_BYTES.
 */
export const MAX_PAGE_SIZE = 150

/**
 * Kept as the name the id-length assertion and its tests use, and now meaning
 * the largest page rather than every page.
 */
export const SLICE_SIZE = MAX_PAGE_SIZE

/**
 * The first page of an hour, before anything is known about its rows.
 *
 * SLOW START. The adaptive size below can only react to bytes it has already
 * seen, so the FIRST page of an hour is the one exposure no measurement can
 * cover. At 25, an hour made entirely of the heaviest execution measured (2.0
 * MB) costs 50 MB on that first page, which fits; at 150 it would be 300 MB and
 * the run would be killed before it could learn anything.
 *
 * It costs almost nothing on a normal hour: the page grows to the ceiling after
 * the first one, so an hour of 3,575 executions pays about one extra read.
 */
export const INITIAL_PAGE_SIZE = 25

/**
 * The smallest page, so a run of enormous executions still makes progress rather
 * than shrinking to nothing.
 */
export const MIN_PAGE_SIZE = 5

/**
 * Bytes of raw rows a page should aim to hold.
 *
 * 24 MB of a 128 MB isolate. Deliberately a small fraction: the raw rows are
 * held alongside the JSON assembled from them and the base64 wires, and the
 * previous slice may not have been collected yet.
 *
 * The page size is derived from this and the bytes actually measured so far in
 * the hour, so a normal hour (about 70 kB per execution including its steps)
 * computes a page far above the ceiling and simply runs at 150, while an hour of
 * 2 MB executions computes 12 and runs at 12.
 */
export const TARGET_SLICE_BYTES = 24 * 1024 * 1024

/** The page to ask for next, from what the hour has actually weighed so far. */
export function nextPageSize(bytesSeen: number, executionsSeen: number): number {
  if (executionsSeen <= 0) return INITIAL_PAGE_SIZE
  const averageBytes = Math.max(1, bytesSeen / executionsSeen)
  const fits = Math.floor(TARGET_SLICE_BYTES / averageBytes)
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, fits))
}

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

  /**
   * What the hour has actually weighed so far, which is what sizes the next
   * page. Measured from the rows themselves rather than assumed from a count
   * (#983).
   */
  let bytesSeen = 0
  let pageSize = INITIAL_PAGE_SIZE

  // Bounded against the SMALLEST page rather than the largest, because the page
  // shrinks on a heavy hour and a bound computed from the ceiling would stop the
  // read partway through with the shortfall reported as a counting problem. One
  // page of slack past the expectation, so a table that grew between the count
  // and the read is DETECTED rather than read forever on a fixed budget.
  const maxSlices = Math.ceil(executionCount.count / MIN_PAGE_SIZE) + 1

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
      .limit(pageSize)
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
    // Bounded rather than while(true): a page of at most MAX_PAGE_SIZE
    // executions cannot legitimately need many pages of steps, and a loop with
    // no bound cannot fail, only hang (L110).
    const maxStepPages = Math.ceil((MAX_PAGE_SIZE * 200) / PAGE_SIZE) + 1
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

    // Weighed BEFORE the slice is handed over, so the next page is sized from
    // what this one actually cost rather than from a count that says nothing
    // about bytes. One extra stringify of rows the encoder is about to stringify
    // anyway: measured at 0.8 ms of CPU per bundle for the whole encode, so this
    // is a fraction of a second across an hour against a 30 s allowance.
    for (const bundle of bundles) bytesSeen += JSON.stringify(bundle).length

    const askedFor = pageSize
    pageSize = nextPageSize(bytesSeen, executionsRead)

    await onSlice(bundles)

    // Against what was ASKED FOR, not against the new page size. A short page is
    // how the loop knows the hour is done, and comparing it to a size that has
    // just been recomputed would end the read early whenever the page shrank.
    if (rows.length < askedFor) break
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
