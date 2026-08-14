import { formatErr } from './format-error'

/**
 * Report a Supabase read that failed inside a scheduled check (#439).
 *
 * These checks read a table, coalesce a null result to `[]`, and carry on. So a
 * transient database error and a genuinely healthy system produced the identical
 * outcome, "nothing to alert on", with nothing in the log to tell them apart.
 *
 * The worst shape is the Slack-connection lookup at the top of nearly every
 * check: on a failed read the org list is empty, the function returns early, and
 * EVERY alert that check owns silently does not run for that tick. The system
 * goes quietest exactly when it is least able to see (LESSONS L98).
 *
 * This deliberately only makes the blind spot VISIBLE. It does not change what
 * the check does next, because for most of these there is nothing useful to do
 * with a failed read beyond saying so, and quietly changing alerting behaviour
 * across fifteen checks at once would be the riskier move.
 */
export function logReadFailure(check: string, what: string, error: unknown): void {
  if (!error) return
  console.error(
    `[${check}] ${what} read FAILED, so this run judged incomplete data and may report all-clear wrongly: ${formatErr(error)}`,
  )
}
