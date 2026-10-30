/**
 * Which kind of outcome_unknown a buyer_select attempt row records (#3087):
 * a live buyer call that got no answer, or an answer no rule matched. Read from
 * the row's typed fields, never its words (L35): `timing` is written only when a
 * request left (buyer-select.ts `timeAttempt`, null when none did), and
 * `http_status` is a number on every answer and null on a call that threw. So a
 * row with timing and no status is a request that got no answer. A row with no
 * timing never called the buyer in this attempt (an earlier sale left in doubt,
 * a ledger entry that could not be settled), so it is not called one.
 *
 * Reading the row the node already writes, rather than a new value on it,
 * changes nothing the engine sends or records, and words every row written
 * since the timing split (#1804), not only the ones written from now on (L389).
 * The node's tests hold the rows it writes to this reader.
 */
import type { UnresolvedAnswer } from './vocab'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The kind of unknown outcome an attempt row records, or null when the row is not one. */
export function unresolvedAnswerOf(attemptOutput: unknown): UnresolvedAnswer | null {
  if (!isRecord(attemptOutput) || attemptOutput.outcome !== 'outcome_unknown') return null
  const requestLeft = isRecord(attemptOutput.timing) && typeof attemptOutput.timing.call_ms === 'number'
  return requestLeft && attemptOutput.http_status === null ? 'no_answer' : 'not_classified'
}
