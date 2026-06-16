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

export async function fetchAllPaged<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; offset < 200_000; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`${label} failed: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
  }
  return out
}
