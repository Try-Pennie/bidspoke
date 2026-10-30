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

  it('labels exactly the two cases', () => {
    expect([...UNRESOLVED_ANSWERS].sort()).toEqual(['no_answer', 'not_classified'])
    expect(Object.keys(UNRESOLVED_ANSWER_LABELS).sort()).toEqual([...UNRESOLVED_ANSWERS].sort())
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
