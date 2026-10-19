/**
 * Paginated PostgREST reads.
 *
 * PostgREST caps a single response at 1,000 rows by default. A bare
 * `.select()` list read of a large/partitioned table (execution_steps,
 * workflow_executions, lead_sightings, bid_matrix_rows, ...) therefore SILENTLY
 * truncates past the cap — and without a stable ORDER BY, Postgres recomputes
 * each OFFSET against an independent scan and skips/duplicates rows. This bug
 * class has recurred several times (volume-cliff, bid-matrix sync/lookup,
 * sf-matrix-audit, slow-execution-rate). Route every full-table read through
 * `fetchAllPaged` so there is one correct implementation.
 *
 * The caller's `makeQuery` MUST include a stable `.order(...)` (a unique
 * tiebreaker like `id` last) followed by `.range(from, to)`.
 */

export const PAGE_SIZE = 1000

/** The page bound when a caller names none: 200 pages, 200,000 rows. */
export const DEFAULT_MAX_PAGES = 200

/**
 * Every row the query matches, or a throw. Never a short list.
 *
 * A read still returning full pages when it reaches its page bound THROWS
 * (`<label> did not reach its last row within N pages`) instead of returning
 * the rows so far, because a short read looks exactly like a complete one
 * (#1785, #1437). The bound is `maxPages` when given (#1681), otherwise
 * DEFAULT_MAX_PAGES. A caller treats the throw as "could not measure", the same
 * as a failed page, never as a count. Measured on 2026-10-19, the largest read
 * any caller makes is the live share check's six hour window of the Engine
 * flow's buyer_select steps, at most 15,991 rows (16 pages), so the default
 * bound sits far above every read today; a caller expected to grow past it
 * narrows its query or names its own bound.
 */
export async function fetchAllPaged<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  label: string,
  opts: { maxPages?: number } = {},
): Promise<T[]> {
  const out: T[] = []
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE
    const { data, error } = await makeQuery(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`${label} failed: ${error.message}`)
    if (!data || data.length === 0) return out
    out.push(...(data as T[]))
    if (data.length < PAGE_SIZE) return out
  }
  throw new Error(`${label} did not reach its last row within ${maxPages} pages`)
}

/** A read that found more rows than its declared bound, so it answered nothing. */
export class RowBoundExceededError extends Error {
  constructor(readonly label: string, readonly bound: number) {
    super(`${label} holds more than ${bound} rows, its declared bound, so it was refused rather than cut short`)
    this.name = 'RowBoundExceededError'
  }
}

/**
 * A list read declared to hold at most `n` rows, read whole or refused (#1437,
 * decision (b)): one organization's config list, a few to a few dozen rows
 * today, where paging would be ceremony. The bounds are in config-list-bounds.ts.
 *
 * Asks for `n + 1` rows through `makeQuery(limit)`, which finishes its query with
 * `.limit(limit)`. Up to `n` back is the whole list. More than `n` throws
 * RowBoundExceededError, never the first `n`, because a list cut short looks
 * exactly like a complete one (L211). A failed read throws with the label too.
 * `n` is a whole number from 1 to PAGE_SIZE - 1, so `n + 1` never passes
 * PostgREST's 1,000 row cap, where a capped answer could not be told from a
 * complete one.
 */
export async function fetchUpTo<T>(
  makeQuery: (limit: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  n: number,
  label: string,
): Promise<T[]> {
  if (!Number.isInteger(n) || n < 1 || n >= PAGE_SIZE) {
    throw new Error(`${label}: a fetchUpTo bound must be a whole number from 1 to ${PAGE_SIZE - 1}, not ${n}`)
  }
  const { data, error } = await makeQuery(n + 1)
  if (error) throw new Error(`${label} failed: ${error.message}`)
  const rows = (data ?? []) as T[]
  if (rows.length > n) throw new RowBoundExceededError(label, n)
  return rows
}
