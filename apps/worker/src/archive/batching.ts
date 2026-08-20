/**
 * Batching for the archive send (#871, Phase A3).
 *
 * Batched by assembled BYTES, never by a row count. The inherited BATCH_SIZE of
 * 200 in the sibling exporter is a row count, and rows here vary by three orders
 * of magnitude: 11.3 kB p50 on the wire, 48.7 kB p99, and a 3.16 MB raw maximum
 * observed. A fixed row count either wastes most of a batch or blows past the
 * budget the first time an hour carries a large execution.
 *
 * What the budget is against is worth stating, because the obvious answer is
 * wrong. Snowflake's per-statement text limit was measured on 2026-08-20 and it
 * accepted 50 MB, roughly 8x a realistic batch, so it cannot fire and sizing
 * against it would be sizing against nothing (L182). The real constraint is the
 * Worker: a 128 MB isolate holds the step rows read from Postgres, the assembled
 * JSON before compression, and the base64 wire strings, all at once.
 */

/**
 * Bytes of assembled wire form per Snowflake statement.
 *
 * 8 MB, deliberately a small fraction of the 128 MB isolate rather than most of
 * it, because the wire strings are the SMALLEST of the three things held at once:
 * the raw JSON they came from is about 4x larger at p50.
 */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024

/**
 * Bytes of wire form above which a single execution is refused by id rather than
 * batched.
 *
 * 6 MB. The largest raw bundle observed in A0 was 3.16 MB and compression is 4x
 * at p50, so nothing measured comes close: this is here to catch a runaway step
 * output, which is a real signal about that execution rather than a batching
 * problem. Letting one through would spend the whole run's headroom on one row.
 */
export const MAX_BUNDLE_BYTES = 6 * 1024 * 1024

export interface SizedBundle {
  executionId: string
  wireBytes: number
}

export interface Batched<T extends SizedBundle> {
  batches: T[][]
  /** Execution ids refused for being over the per-bundle ceiling, by id so they can be recorded. */
  oversized: string[]
}

export function batchByBytes<T extends SizedBundle>(items: T[]): Batched<T> {
  const batches: T[][] = []
  const oversized: string[] = []

  let current: T[] = []
  let currentBytes = 0

  for (const item of items) {
    if (item.wireBytes > MAX_BUNDLE_BYTES) {
      oversized.push(item.executionId)
      continue
    }
    if (current.length > 0 && currentBytes + item.wireBytes > MAX_BATCH_BYTES) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += item.wireBytes
  }

  // Only push a trailing batch that has something in it: an empty batch would
  // become a statement sending nothing, which reads downstream as a send that
  // happened.
  if (current.length > 0) batches.push(current)

  return { batches, oversized }
}
