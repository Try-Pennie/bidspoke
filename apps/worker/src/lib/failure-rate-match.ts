/**
 * Which runs a failure rate signal counts (#248), in ONE place (#2102).
 *
 * Two readers ask the same question of workflow_executions: the failure rate
 * check (failure-rate.ts), deciding whether matching failures crossed a
 * threshold, and the incident record (incident-failed-runs.ts), listing the
 * failed runs behind an incident that check opened. If they decided "matching"
 * two ways, the card would count runs the alert never saw, or miss runs it did
 * (L263, L370). So both apply the candidate filter and the match below, and
 * neither keeps a copy.
 *
 * A candidate is a real (not test) run that failed with an error message; it
 * matches when the signal's text appears in that message, ignoring case.
 */

/** True when `match` (non-blank) appears, case-insensitively, in errorMessage. */
export function signalMatches(errorMessage: string | null | undefined, match: string): boolean {
  if (!errorMessage || !match || !match.trim()) return false
  return errorMessage.toLowerCase().includes(match.toLowerCase())
}

/** The part of a PostgREST builder the candidate filter uses. */
interface FilterableQuery<Q> {
  eq(column: string, value: unknown): Q
  not(column: string, operator: string, value: unknown): Q
}

/**
 * The runs a failure rate signal can count: real runs that failed with an error
 * message. Apply it to a workflow_executions read, then keep the rows whose
 * error_message `signalMatches` the signal.
 */
export function onlyFailureRateCandidates<Q extends FilterableQuery<Q>>(query: Q): Q {
  return query
    .eq('is_test', false)
    .eq('status', 'failed')
    .not('error_message', 'is', null)
}
