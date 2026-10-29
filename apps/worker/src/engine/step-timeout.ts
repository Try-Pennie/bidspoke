/**
 * A step that hit a deadline, classified once where it happens (#3047, L35).
 *
 * withTimeout (engine/retry.ts) rejects with a StepTimeoutError when a step's
 * own deadline passes, and the walk writes that onto the step row as
 * `timeout_kind` and `timed_out_after_ms` (stepTimeoutMarkerOf). A parallel
 * block that stops waiting for a child writes the child's row itself, marked
 * PARALLEL_BLOCK_DEADLINE. Every other step row carries neither column.
 *
 * `error_type` stays `transient` for a timeout: it decides whether a step is
 * retried (withRetry retries only `transient`) and how an alert labels it, so a
 * new value there would have changed both. The marker is beside it instead.
 *
 * Readers ask stepTimedOut / stepTimedOutAfterMs here, and the step timeout
 * audit asks the same in SQL (step_timeout_audit_by_workflow), never the text.
 * The database holds no CHECK on `timeout_kind`, as it holds none on
 * `error_type` or `status` (20260617000002): TIMEOUT_KINDS below is the one list.
 */

/** The step's own deadline (its `timeout_ms`) passed. */
export const STEP_DEADLINE = 'step'
/** The step's parallel block stopped waiting for it (the block's `timeout_ms`). */
export const PARALLEL_BLOCK_DEADLINE = 'parallel_block'
/** Every value a step row's `timeout_kind` can hold. */
export const TIMEOUT_KINDS = [STEP_DEADLINE, PARALLEL_BLOCK_DEADLINE] as const
export type TimeoutKind = (typeof TIMEOUT_KINDS)[number]

/** What a step row records about a deadline it hit. Absent, never null, on any other row. */
export interface StepTimeoutMarker {
  timeout_kind: TimeoutKind
  /** Null only when the configured deadline is not a length the INTEGER column can hold. */
  timed_out_after_ms: number | null
}

/** Postgres INTEGER's largest value. */
const INT4_MAX = 2_147_483_647

/**
 * The marker for a row a deadline of `ms` stopped. `ms` comes from a node's
 * config unvalidated, and a value the INTEGER column refuses would fail the
 * step's row on insert, so it is rounded to whole ms, and one still outside
 * 1 to INT4_MAX is left out: the row still says it timed out.
 */
export function timeoutMarker(kind: TimeoutKind, ms: unknown): StepTimeoutMarker {
  const whole = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms) : Number.NaN
  return { timeout_kind: kind, timed_out_after_ms: whole >= 1 && whole <= INT4_MAX ? whole : null }
}

/**
 * The error a step fails with when its own deadline passes, which its step row
 * records as `error_message`. The wording is unchanged by #3047: alerts, the run
 * page and rows written before the marker all carry it.
 */
export function stepTimeoutMessage(ms: number): string {
  return `Step timed out after ${ms}ms (in-flight upstream call canceled via abort signal)`
}

/** What withTimeout rejects with: the message above, and the deadline as a number. */
export class StepTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(ms: number) {
    super(stepTimeoutMessage(ms))
    this.timeoutMs = ms
  }
}

/** The marker for a step row whose step failed with `err`: set only when its own deadline stopped it, never from text. */
export function stepTimeoutMarkerOf(err: unknown): StepTimeoutMarker | null {
  return err instanceof StepTimeoutError ? timeoutMarker(STEP_DEADLINE, err.timeoutMs) : null
}

/** The step row columns a reader passes in. */
export interface TimeoutColumns {
  timeout_kind?: unknown
  timed_out_after_ms?: unknown
  error_message?: unknown
}

/** Whether a recorded step was stopped by its own deadline. */
export function stepTimedOut(row: TimeoutColumns): boolean {
  if (row.timeout_kind !== null && row.timeout_kind !== undefined) return row.timeout_kind === STEP_DEADLINE
  return legacyStepTimeoutMs(row.error_message) !== null
}

/** The deadline, in ms, a recorded step was stopped at, or null when it was not stopped by its own deadline or the deadline is not recorded. */
export function stepTimedOutAfterMs(row: TimeoutColumns): number | null {
  if (row.timeout_kind !== null && row.timeout_kind !== undefined) {
    const ms = row.timed_out_after_ms
    return row.timeout_kind === STEP_DEADLINE && typeof ms === 'number' && Number.isInteger(ms) && ms > 0 ? ms : null
  }
  return legacyStepTimeoutMs(row.error_message)
}

const STEP_TIMEOUT = /^Step timed out after (\d+)ms \(in-flight upstream call canceled via abort signal\)$/

/**
 * THE TEXT FALLBACK, for a step row written before #3047, which says it timed
 * out only in its message. A row with no `timeout_kind` is read this way.
 *
 * WHEN IT CAN GO: once no such row is left where a reader looks. Step rows are
 * kept 7 days, and both readers (the direct write report, one to two days, and
 * the step timeout audit, five) read only kept rows, so 8 days after the Worker
 * carrying #3047 deployed: 2026-11-07 if it deployed by 2026-10-30. Remove it
 * with the matching `error_message LIKE` in step_timeout_audit_by_workflow, and
 * give the tests' legacy rows a marker.
 */
function legacyStepTimeoutMs(errorMessage: unknown): number | null {
  if (typeof errorMessage !== 'string') return null
  const m = STEP_TIMEOUT.exec(errorMessage)
  return m ? Number(m[1]) : null
}
