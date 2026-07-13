/**
 * Execution status display logic (AUD-012 / #477).
 *
 * The execution detail page used to render whatever raw status came back, with an
 * unknown status silently falling back to the "running" style and a running badge
 * that never updated. This resolves the raw status into a display status that
 * honours the working / still-alive / failed rule:
 *   - a running execution stays "running" (with live elapsed) until it has been
 *     alive past the stall threshold, then converts to "stalled";
 *   - an unrecognized status becomes a neutral "unknown" rather than masquerading
 *     as running.
 *
 * Threshold grounded in prod data (2026-07-02): over 7 days of 620k completed
 * runs, p99.9 duration was 27s and only 5 runs (0.0008%) exceeded 60s, while dead
 * "strand" rows that never finalize sit far past it. 60s cleanly separates a
 * genuinely slow run from a hung one.
 */

export type ExecutionDisplayStatus =
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'skipped'
  | 'running'
  | 'failed_with_fallback'
  | 'stalled'
  | 'unknown'

export const STALL_THRESHOLD_MS = 60_000

/**
 * User-facing labels for the execution outcome taxonomy, in one place so every
 * surface says the same word for the same state. The executions filter row is a
 * fixed 288px panel and all five tabs must fit on one line, which is what forces
 * the short forms ('Success', 'Done') over the spelled-out status names.
 */
export const OUTCOME_LABELS = {
  successful: 'Success',
  completed: 'Done',
  degraded: 'Degraded',
  failed: 'Failed',
} as const

const KNOWN_STATUSES = new Set<string>([
  'completed',
  'degraded',
  'failed',
  'skipped',
  'running',
  'failed_with_fallback',
])

export function resolveExecutionStatus(
  status: string,
  startedAtMs: number,
  nowMs: number,
  stallThresholdMs: number = STALL_THRESHOLD_MS,
): ExecutionDisplayStatus {
  if (status === 'running') {
    return nowMs - startedAtMs >= stallThresholdMs ? 'stalled' : 'running'
  }
  if (KNOWN_STATUSES.has(status)) return status as ExecutionDisplayStatus
  return 'unknown'
}

/** Whether the engine is still expected to update this execution (so the page
 *  should keep polling). Only a raw `running` status is non-terminal. */
export function isRunningStatus(status: string): boolean {
  return status === 'running'
}
