/**
 * An unresolved buyer call, worded by whether an answer arrived (#3087). Dan,
 * 2026-10-30: a live buyer call that got no answer (our timer, a connection
 * failure, a cancelled call) reads "No answer from the buyer" and "No answer";
 * an answer that arrived but no rule matched keeps "Buyer response could not be
 * classified" and "Answer not classified". Both are one list here, and the
 * outcome_unknown labels of the two code lists are read from it, so a third
 * wording cannot appear on one surface only (L605, L611). The plain words check
 * of every reason label (vocab.test.ts) covers these too, through those lists.
 */
import { describe, expect, it } from 'vitest'
import { CONSIDERED_OUTCOME_LABELS, OUT_REASON_LABELS, UNRESOLVED_ANSWERS, UNRESOLVED_ANSWER_LABELS } from '../vocab'
import { unresolvedAnswerOf } from '../unresolved-answer'

const timing = { before_call_ms: 40, call_ms: 20000, after_call_ms: 12 }

describe('the unresolved answer labels', () => {
  it('words a call that got no answer as Dan chose', () => {
    expect(UNRESOLVED_ANSWER_LABELS.no_answer).toEqual({ reason: 'No answer from the buyer', outcome: 'No answer' })
  })

  it('keeps the words for an answer no rule matched', () => {
    expect(UNRESOLVED_ANSWER_LABELS.not_classified).toEqual({ reason: 'Buyer response could not be classified', outcome: 'Answer not classified' })
  })

  // #3129, Dan 2026-10-30: the buyer accepted, and Bidspoke's own commit or
  // mark sold after it failed, so the sale stands at the buyer and is not
  // recorded here.
  it('words an accepted answer whose sale could not be recorded as Dan chose (#3129)', () => {
    expect(UNRESOLVED_ANSWER_LABELS.accepted_not_recorded).toEqual({ reason: 'Buyer accepted, but the sale could not be recorded', outcome: 'Sale not recorded' })
  })

  it('labels exactly the three cases, in plain words with no dash or emoji', () => {
    expect([...UNRESOLVED_ANSWERS].sort()).toEqual(['accepted_not_recorded', 'no_answer', 'not_classified'])
    expect(Object.keys(UNRESOLVED_ANSWER_LABELS).sort()).toEqual([...UNRESOLVED_ANSWERS].sort())
    for (const kind of UNRESOLVED_ANSWERS) {
      for (const words of Object.values(UNRESOLVED_ANSWER_LABELS[kind])) {
        expect(words, kind).toMatch(/^[^\u{2013}\u{2014}\u{1F300}-\u{1FAFF}_]+$/u)
      }
    }
  })

  it('is where the outcome_unknown labels of both code lists come from', () => {
    expect(OUT_REASON_LABELS.outcome_unknown).toBe(UNRESOLVED_ANSWER_LABELS.not_classified.reason)
    expect(CONSIDERED_OUTCOME_LABELS.outcome_unknown).toBe(UNRESOLVED_ANSWER_LABELS.not_classified.outcome)
  })
})

describe('unresolvedAnswerOf, from the attempt row the buyer_select node writes', () => {
  it('a request that left and came back with no status got no answer', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true, timing })).toBe('no_answer')
  })

  it('an answer with a status that no rule matched was not classified', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, timing })).toBe('not_classified')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 503, held: true, timing })).toBe('not_classified')
  })

  it('an unknown outcome where no request left in this attempt is not called a call that got no answer', () => {
    // An earlier attempt left the sale in doubt, or the ledger could not be read: no buyer call, so no timing.
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true })).toBe('not_classified')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true, timing: null })).toBe('not_classified')
  })

  it('any other outcome, or a row it cannot read, is not an unresolved answer', () => {
    expect(unresolvedAnswerOf({ outcome: 'declined_by_buyer', http_status: null, timing })).toBeNull()
    expect(unresolvedAnswerOf({ outcome: 'accepted', http_status: 200, timing })).toBeNull()
    expect(unresolvedAnswerOf(null)).toBeNull()
    expect(unresolvedAnswerOf('outcome_unknown')).toBeNull()
    expect(unresolvedAnswerOf([])).toBeNull()
  })

  it('a missing status is not read as no status', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', timing })).toBe('not_classified')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: '200', timing })).toBe('not_classified')
  })
})

/**
 * #3129: the row now records the buyer's classified answer as `answer`, so an
 * accepted answer whose commit or mark sold failed afterwards (buyer-sale-attempt.ts
 * steps 4 and 5) reads apart from an answer no rule matched. Both carry http 200.
 */
describe('unresolvedAnswerOf reads the answer the row records (#3129)', () => {
  const afterCommit = { ...timing, commit_ms: 90 }

  it('an accepted answer on an unknown outcome is a sale that could not be recorded', () => {
    // The commit failed: no commit_ms.
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, answer: 'accepted', timing })).toBe('accepted_not_recorded')
    // The mark sold failed after the commit landed.
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, answer: 'accepted', timing: afterCommit })).toBe('accepted_not_recorded')
  })

  it('an unmatched answer is still not classified', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, answer: 'unmatched', timing })).toBe('not_classified')
  })

  it('a recorded answer of any kind means one arrived, so it is never read as no answer', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true, answer: 'unmatched', timing })).toBe('not_classified')
  })

  it('an accepted answer on a row that recorded the sale is not unresolved', () => {
    expect(unresolvedAnswerOf({ outcome: 'accepted', http_status: 200, answer: 'accepted', timing: afterCommit })).toBeNull()
  })

  it('a row written before the field keeps the reading it had', () => {
    // An accepted answer whose mark sold failed, as it was recorded before #3129: no answer field.
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, timing: afterCommit })).toBe('not_classified')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true, timing })).toBe('no_answer')
  })

  it('an answer value it does not know is read as a row without one', () => {
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: null, held: true, answer: 'maybe', timing })).toBe('no_answer')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, answer: 'constructor', timing })).toBe('not_classified')
    expect(unresolvedAnswerOf({ outcome: 'outcome_unknown', http_status: 200, held: true, answer: null, timing })).toBe('not_classified')
  })
})
