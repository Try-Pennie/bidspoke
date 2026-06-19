// Shared transient-retry primitive for best-effort Supabase writes.
//
// The nightly partition-purge cron runs DDL on partitioned tables, which forces
// a PostgREST schema-cache reload that 503s writes for a few seconds ("Could
// not query the database for the schema cache.", PGRST002). The execution-log
// hot path (engine/step-logger.ts) survives this with a Hyperdrive direct-pg
// path plus a retry ladder; the analytics writes (lead_sightings, etc.) had no
// retry and silently dropped rows in that window (#237).
//
// This module is the single source of truth for the transient-vs-permanent
// classification (shared with step-logger) and a PostgREST-only retry helper for
// the writes that don't go through the Hyperdrive path.

export interface DbError {
  code?: string
  message: string
}

// SQLSTATE / PostgREST codes where retrying cannot help — the row is malformed
// or the schema drifted. Everything else (lock contention, schema-cache reload,
// connection blips) is transient and retried. 23505 (unique_violation) is
// handled separately by callers: for an append-only insert a duplicate means the
// row already exists, which is success.
const PERMANENT_DB_CODES = new Set([
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23514', // check_violation
  '22P02', // invalid_text_representation (bad uuid / enum)
  '22007', // invalid_datetime_format
  '22008', // datetime_field_overflow
  '42703', // undefined_column (migration drift)
  '42P01', // undefined_table
  '42804', // datatype_mismatch
  'PGRST204', // PostgREST: column not in schema cache (drift, not transient)
])

export function isPermanentDbError(err: DbError | null): boolean {
  return !!err?.code && PERMANENT_DB_CODES.has(err.code)
}

export function isDuplicateError(err: DbError | null): boolean {
  return err?.code === '23505'
}

export function toDbError(e: unknown): DbError {
  const err = e as { code?: unknown; message?: unknown }
  return {
    code: typeof err?.code === 'string' ? err.code : undefined,
    message: typeof err?.message === 'string' ? err.message : String(e),
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Retry delays for best-effort writes. These run inside waitUntil(), off the
// request critical path, so the added wall-clock is free. The ladder mirrors the
// execution-log CREATE ladder so it outlasts the same partition-purge
// schema-cache reload window.
export const DB_WRITE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000]

// Runs a PostgREST operation (one that resolves to `{ error }`), retrying on
// transient errors and failing fast on permanent ones. Returns the final
// `{ error }` so callers can branch (e.g. treat a duplicate as success).
export async function withDbRetry(
  op: () => Promise<{ error: DbError | null }>,
  delaysMs: number[] = DB_WRITE_RETRY_DELAYS_MS,
): Promise<{ error: DbError | null }> {
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1])
    const { error } = await op()
    if (!error) return { error: null }
    if (isPermanentDbError(error)) return { error }
    lastError = error
  }
  return { error: lastError }
}
