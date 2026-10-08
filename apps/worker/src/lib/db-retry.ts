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
import { formatErr } from './format-error'
import { waitToRetry, type RetryTiming } from './post-response-budget'

export interface DbError {
  code?: string
  message: string
}

// Synthetic code for a write whose target row does not exist (#487, #583). Not a
// SQLSTATE: PostgREST reports a zero-row UPDATE/DELETE as a plain success, so we
// manufacture the error ourselves. Permanent by definition, because waiting
// cannot make a row that does not exist appear.
export const NO_ROW_MATCHED_CODE = 'BIDSPOKE_NO_ROW_MATCHED'

// A write that timed out at the post-response budget, read back minutes later
// and found never to have landed (#1880). Its own code so the lost alert says
// that, rather than blaming a retry ladder that never reported an error.
export const READ_BACK_MISSING_CODE = 'BIDSPOKE_READ_BACK_MISSING'

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
  NO_ROW_MATCHED_CODE,
])

export function isPermanentDbError(err: DbError | null): boolean {
  return !!err?.code && PERMANENT_DB_CODES.has(err.code)
}

export function isNoRowMatchedError(err: DbError | null): boolean {
  return err?.code === NO_ROW_MATCHED_CODE
}

export function isDuplicateError(err: DbError | null): boolean {
  return err?.code === '23505'
}

/**
 * A DbError is a plain object, not an Error, so it cannot be thrown directly.
 * Wraps it while keeping the SQLSTATE on the thrown value, so a catch that
 * classifies by `code` still can.
 */
export function toThrowable(err: DbError): Error {
  return Object.assign(new Error(err.message), { code: err.code })
}

/**
 * The shape every PostgREST call resolves to, as far as error reporting cares.
 * supabase-js puts `status` and `statusText` on the same object as `error`, so
 * the HTTP status is always available at the moment the error is normalized.
 */
export interface PostgrestResultLike {
  error: { code?: string | null; message?: string | null } | null
  status?: number
  statusText?: string
}

/**
 * Normalizes a PostgREST result's error into a DbError WITHOUT losing the HTTP
 * status (#1111).
 *
 * A failure that carries no body carries its entire diagnosis in the status
 * line. On 2026-09-02 Supabase answered three consecutive execution-finalize
 * PATCHes with HTTP 500, `content-length: 0` and no content-type; postgrest-js
 * turned that into `{ message: '' }` with no code, and every layer above
 * faithfully passed the emptiness along until the Slack alert read
 * `Error: {"message":""}`. The status was sitting unread on the same response
 * the whole time (LESSONS L520).
 *
 * So: keep a real message exactly as PostgREST worded it, and fall back to the
 * status only when there is nothing else to say. Deliberately assigns NO code in
 * that fallback, because an HTTP status is not a SQLSTATE and inventing one
 * would feed isPermanentDbError a value it never classified: a bare 500 is
 * transient, which is what an absent code already means.
 */
export function normalizeDbError(res: PostgrestResultLike): DbError | null {
  const raw = res.error
  if (!raw) return null

  // postgrest-js reports "no code" as an empty string on some failures. That is
  // not a SQLSTATE, and carrying it would make `!!err.code` true for a value
  // that classifies nothing.
  const code = typeof raw.code === 'string' && raw.code !== '' ? raw.code : undefined
  const message = typeof raw.message === 'string' && raw.message.trim() !== '' ? raw.message : undefined
  if (message) return { code, message }

  return { code, message: describeEmptyFailure(res) }
}

// Status leads, mirroring format-error.ts's Response rendering, so it survives
// the head-and-tail truncation the alert applies.
function describeEmptyFailure(res: PostgrestResultLike): string {
  if (typeof res.status !== 'number') {
    return 'Supabase returned an error carrying no message and no HTTP status'
  }
  const statusText = typeof res.statusText === 'string' && res.statusText.trim() !== '' ? ` ${res.statusText}` : ''
  return `Supabase returned HTTP ${res.status}${statusText} with an empty error body`
}

export function toDbError(e: unknown): DbError {
  const err = e as { code?: unknown; message?: unknown }
  return {
    code: typeof err?.code === 'string' ? err.code : undefined,
    message: typeof err?.message === 'string' ? err.message : formatErr(e),
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Retry delays for best-effort writes. On the engine path these run inside
// waitUntil(), which Cloudflare cancels 30 seconds after the response, so the
// wall clock is NOT free: the ladder plus its dead letter must fit the shared
// post-response budget (lib/post-response-budget.ts, #1850). 14 seconds still
// outlasts the partition-purge schema-cache reload (a few seconds), and the
// caller's timing cuts it shorter when the run's budget is already spent.
export const DB_WRITE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

/**
 * What a caller wants to happen when the write touched no row (#590).
 *
 * `silent` returns the synthetic error and says nothing, leaving the caller to
 * branch (a route turns it into a 404; an idempotent clear reads `rows` and
 * skips its audit write). `error` and `warn` emit one structured line. `throw`
 * raises, for the writes whose miss corrupts the job (an unmarked export batch
 * re-exports forever).
 */
export type ZeroRowPolicy = 'silent' | 'warn' | 'error' | 'throw'

export interface RequireRowsOptions {
  onMiss?: ZeroRowPolicy
  /** Extra fields folded into the structured log line (ids, slugs, workflow). */
  context?: Record<string, unknown>
}

// Runs a PostgREST UPDATE/DELETE whose target row MUST exist, converts the
// zero-rows-matched case into a real error, and reports how many rows it hit.
//
// PostgREST answers a well-formed UPDATE that matched nothing with
// `{ data: [], error: null }`, a statement that succeeded and changed nothing.
// Destructuring `error` therefore reports success for a write that silently did
// not happen. The caller must add `.select(<col>)` so PostgREST returns the rows
// it touched.
//
// `target` names the write (e.g. 'lead_sighting_bids.winner') and lands in the
// error message, the log, and any dead-letter alert. `onMiss` is the reaction:
// it exists so the six sites that used to hand-roll this check, each reacting
// differently, share one implementation (#590).
//
// A real database error is NEVER run through `onMiss`. It is a different failure
// from a missing row, it may be transient, and it flows back untouched so the
// caller can retry or answer 500. Collapsing the two is the #303 bug.
export async function requireRowsAffected<T = unknown>(
  target: string,
  // The error is typed as PostgREST words it (a nullable code), not as the
  // DbError this returns: normalizeDbError is what converts between them, and
  // declaring the narrower type here would push that conversion onto callers.
  op: () => PromiseLike<{
    data: T[] | null
    error: { code?: string | null; message?: string | null } | null
    status?: number
    statusText?: string
  }>,
  opts: RequireRowsOptions = {},
): Promise<{ rows: T[]; error: DbError | null }> {
  // `status`/`statusText` are destructured alongside the error because a failure
  // whose body named nothing carries its whole diagnosis in the status line, and
  // normalizeDbError is what keeps it (#1111). A real PostgREST message is
  // passed through untouched.
  const { data, error: rawError, status, statusText } = await op()
  const error = normalizeDbError({ error: rawError, status, statusText })
  if (error) return { rows: [], error }

  // `rows` is the rows the write touched, so `rows.length` is the count and the
  // rows themselves are available to a caller that needs the id it just deleted.
  if (data?.length) return { rows: data, error: null }

  const message = `${target}: write matched zero rows (the target row does not exist)`
  const onMiss = opts.onMiss ?? 'silent'
  if (onMiss === 'throw') throw new Error(message)
  if (onMiss === 'error' || onMiss === 'warn') {
    const line = JSON.stringify({ event: 'zero_row_write', target, message, ...opts.context })
    if (onMiss === 'error') console.error(line)
    else console.warn(line)
  }
  return { rows: [], error: { code: NO_ROW_MATCHED_CODE, message } }
}

// Runs a PostgREST operation (one that resolves to `{ error }`), retrying on
// transient errors and failing fast on permanent ones. Returns the final
// `{ error }` so callers can branch (e.g. treat a duplicate as success).
// `timing` supplies the clock and the post-response budget (#1850): a retry
// whose wait would run past the cut-off is not made, and the last error is
// returned instead so the caller's dead letter still has time to run.
export async function withDbRetry(
  op: () => Promise<{ error: DbError | null }>,
  delaysMs: readonly number[] = DB_WRITE_RETRY_DELAYS_MS,
  timing?: RetryTiming,
): Promise<{ error: DbError | null }> {
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0 && !(await waitToRetry(delaysMs[attempt - 1], timing))) break
    const { error } = await op()
    if (!error) return { error: null }
    if (isPermanentDbError(error)) return { error }
    lastError = error
  }
  return { error: lastError }
}
