/**
 * Buffers the archive's refusals so they reach Postgres as batched upserts that
 * the run's subrequest budget can actually see (#965).
 *
 * A refusal used to be one PostgREST call, issued the moment the disposition
 * loop decided it, outside the budget entirely. That is fine for the handful of
 * refusals a healthy hour produces and fatal for the case the ledger exists to
 * record: #949 measured 5,617 of 5,617 executions in one hour refused for a
 * tenancy mismatch. Issued one at a time, that hour would exceed the platform's
 * per invocation subrequest limit while `subrequestsLeft()` still reported
 * around 840, so the loop's clean stop could not fire and the invocation would
 * be killed. A killed invocation writes no summary and raises no alert, so the
 * mass refusal alert would be destroyed by the very event it announces.
 *
 * Batching also removes the per row failure mode: with one write per refusal,
 * any single row that Postgres rejects throws inside the run and stalls the
 * watermark on an hour that can never pass.
 */

/**
 * Rows per upsert.
 *
 * A slice is SLICE_SIZE (150) executions and the buffer is flushed at the end of
 * every slice, so in practice one slice is one request and this ceiling never
 * binds. It is here for the case where it would: the caller decides when to
 * flush, and a caller that flushed only at the end of a run must not assemble a
 * single request holding an hour's 5,617 rows.
 */
export const MAX_REFUSAL_ROWS_PER_REQUEST = 500

export interface RefusalRecord {
  execution_id: string
  archive_day: string
  reason: string
  refused_at: string
  resolved_at: null
}

export interface RefusalBuffer {
  /** Holds the refusal. Nothing is written until the buffer is flushed or fills. */
  add: (record: RefusalRecord) => Promise<void>
  /** Writes everything held, in requests of at most MAX_REFUSAL_ROWS_PER_REQUEST. */
  flush: () => Promise<void>
  /** Rows still unwritten. Read after a run to name what a failure lost, not to decide anything. */
  readonly buffered: number
}

export interface RefusalBufferDeps {
  /**
   * Issues ONE request. The caller counts here rather than being told how many
   * requests to expect, so the budget is decremented by requests actually made
   * rather than by an estimate of them (L182).
   */
  writeBatch: (rows: RefusalRecord[]) => Promise<void>
  maxRowsPerRequest?: number
}

export function createRefusalBuffer(deps: RefusalBufferDeps): RefusalBuffer {
  const max = deps.maxRowsPerRequest ?? MAX_REFUSAL_ROWS_PER_REQUEST
  if (max < 1) throw new Error(`a refusal batch must hold at least one row, not ${max}`)
  let pending: RefusalRecord[] = []

  async function flush(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending.slice(0, max)
      // Removed from the buffer only AFTER the write returns, so a failed write
      // leaves the rows in the buffer for the caller to name rather than
      // dropping them on the floor while reporting nothing.
      await deps.writeBatch(batch)
      pending = pending.slice(batch.length)
    }
  }

  return {
    async add(record: RefusalRecord): Promise<void> {
      pending.push(record)
      if (pending.length >= max) await flush()
    },
    flush,
    get buffered(): number {
      return pending.length
    },
  }
}
