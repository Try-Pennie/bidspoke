/**
 * A step that hit a deadline, classified once where it happens (#3047, L35).
 *
 * withTimeout (engine/retry.ts) rejects with a StepTimeoutError when a step's
 * own deadline passes, and the walk writes that onto the step row as
 * `timeout_kind` and `timed_out_after_ms` (stepTimeoutMarkerOf). A parallel
 * block that stops waiting for a child writes the child's row itself, marked
 * PARALLEL_BLOCK_DEADLINE.
 *
 * Our other deadlines are marked where they pass too (#3068), each as its own
 * kind: a code chain's dispatch, a node's own request timer, the partner bid's
 * bid request, a bid group that stops waiting for a partner, and the buyer
 * select budget. A timer marks the error its own abort caused (abortAfter,
 * markDeadline), never by its text: "The operation was aborted" is what every
 * abort says. Every other step row carries neither column.
 *
 * WHICH ROW CARRIES IT. The row of the step whose work the deadline cut short,
 * whatever status it ends in, as the step's own deadline already marks a
 * skipped or failed_with_fallback row. A parent that absorbed a child's
 * deadline and carried on is not marked, since nothing stopped it: a bid group
 * that stopped waiting for one partner marks that partner's attempt row, never
 * its own. Only STEP_DEADLINE is what the step timeout audit and the daily
 * writes report count, so a new kind changes neither.
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
/** A chain of code nodes dispatched as one call ran past the chain's deadline (the sum of its nodes' budgets). */
export const CODE_CHAIN_DEADLINE = 'code_chain'
/** A node's own request timer aborted its call: the Salesforce node's calls and token fetch, the webhook node's request. */
export const REQUEST_DEADLINE = 'request'
/** The partner bid's own timer aborted its bid request to the partner. */
export const PARTNER_BID_DEADLINE = 'partner_bid'
/** A highest bid race stopped waiting for this partner attempt (the bid group's `timeout_ms`). */
export const BID_GROUP_DEADLINE = 'bid_group'
/** The buyer select node's budget ran out and ended its walk. */
export const BUYER_SELECT_DEADLINE = 'buyer_select'
/** Every value a step row's `timeout_kind` can hold. */
export const TIMEOUT_KINDS = [
  STEP_DEADLINE,
  PARALLEL_BLOCK_DEADLINE,
  CODE_CHAIN_DEADLINE,
  REQUEST_DEADLINE,
  PARTNER_BID_DEADLINE,
  BID_GROUP_DEADLINE,
  BUYER_SELECT_DEADLINE,
] as const
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

/**
 * Errors one of our deadlines caused, and the marker each carries (#3068). Kept
 * beside the error rather than on it, so the error itself (its message, name
 * and class, which classifyStepError and every alert read) is exactly what it
 * was, and a timed out step is retried exactly as before.
 */
const DEADLINE_MARKS = new WeakMap<object, StepTimeoutMarker>()

/** Records that `err` was caused by one of our deadlines of `ms`. Returns `err` unchanged; a value that is not an object is left unmarked. */
export function markDeadline<T>(err: T, kind: TimeoutKind, ms: unknown): T {
  if (typeof err === 'object' && err !== null) DEADLINE_MARKS.set(err, timeoutMarker(kind, ms))
  return err
}

/** For a node that re-wraps an error: `to` carries whatever marker `from` carried. Returns `to`. */
export function carryDeadline<T>(from: unknown, to: T): T {
  const marker = typeof from === 'object' && from !== null ? DEADLINE_MARKS.get(from) : undefined
  if (marker && typeof to === 'object' && to !== null) DEADLINE_MARKS.set(to, marker)
  return to
}

/**
 * The marker for a step row whose step failed with `err`: set only when one of
 * our deadlines stopped it, never from text. The step's own deadline first,
 * since it is what the walk saw stop the step.
 */
export function stepTimeoutMarkerOf(err: unknown): StepTimeoutMarker | null {
  if (err instanceof StepTimeoutError) return timeoutMarker(STEP_DEADLINE, err.timeoutMs)
  if (typeof err !== 'object' || err === null) return null
  return DEADLINE_MARKS.get(err) ?? null
}

/** A node's own timer on one call, which knows whether it was the one that aborted it. */
export interface OwnTimer {
  /** Whether this timer aborted the controller. False when anything else aborted it first. */
  fired(): boolean
  /** Stops the timer; call it once the call has answered or thrown. */
  clear(): void
  /** Marks `err` with this timer's kind and deadline when this timer fired, and returns it either way. */
  mark<T>(err: T): T
}

/**
 * Aborts `controller` after `ms`, as `setTimeout(() => controller.abort(), ms)`
 * did, and remembers that it did (#3068). A controller already aborted (the
 * step deadline reaching it through linkAbort, say) is left alone and the timer
 * does not count as having fired, so only the abort this timer caused is marked.
 *
 * Reads the global setTimeout at the call, never at import, so the money gate's
 * lift of the engine's timers still reaches it.
 */
export function abortAfter(controller: AbortController, ms: number, kind: TimeoutKind): OwnTimer {
  let fired = false
  const handle = setTimeout(() => {
    if (controller.signal.aborted) return
    fired = true
    controller.abort()
  }, ms)
  return {
    fired: () => fired,
    clear: () => clearTimeout(handle),
    mark: (err) => (fired ? markDeadline(err, kind, ms) : err),
  }
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
