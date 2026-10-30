/**
 * Which kind of outcome_unknown a buyer_select attempt row records (#3087,
 * #3129): a live buyer call that got no answer, an answer no rule matched, or an
 * accepted answer whose sale could not be recorded afterwards. Read from the
 * row's typed fields, never its words (L35).
 *
 * `answer` (#3129) is the buyer's classified answer, written only when one
 * arrived (`ATTEMPT_ANSWERS`). An accepted answer on an outcome_unknown row is a
 * sale the buyer took and Bidspoke's commit or mark sold then failed to record;
 * any other recorded answer arrived and was not a sale, so it was not classified
 * as one.
 *
 * A row with no `answer` (none arrived, or the row was written before #3129)
 * keeps the reading #3087 gave it: `timing` is written only when a request left
 * (buyer-select.ts `timeAttempt`, null when none did), and `http_status` is a
 * number on every answer and null on a call that threw. So a row with timing and
 * no status is a request that got no answer. A row with no timing never called
 * the buyer in this attempt (an earlier sale left in doubt, a ledger entry that
 * could not be settled), so it is not called one. An accepted answer recorded
 * before #3129 cannot be told from an unmatched one, so it still reads as not
 * classified (L389).
 *
 * The node's tests hold the rows it writes to this reader.
 */
import { ATTEMPT_ANSWERS, type AttemptAnswer, type UnresolvedAnswer } from './vocab'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isAttemptAnswer = (v: unknown): v is AttemptAnswer => typeof v === 'string' && (ATTEMPT_ANSWERS as readonly string[]).includes(v)

/** The kind of unknown outcome an attempt row records, or null when the row is not one. */
export function unresolvedAnswerOf(attemptOutput: unknown): UnresolvedAnswer | null {
  if (!isRecord(attemptOutput) || attemptOutput.outcome !== 'outcome_unknown') return null
  const answer = attemptOutput.answer
  if (isAttemptAnswer(answer)) return answer === 'accepted' ? 'accepted_not_recorded' : 'not_classified'
  const requestLeft = isRecord(attemptOutput.timing) && typeof attemptOutput.timing.call_ms === 'number'
  return requestLeft && attemptOutput.http_status === null ? 'no_answer' : 'not_classified'
}
