import { describe, expect, it } from 'vitest'
import { evaluateSaleOutcome, getBodyField, looseEquals, matchSignal, responseClassOf, type Signal } from '../outcome'
import success1001 from '../../fixtures/tripoint/success-1001.json'
import duplicate1002 from '../../fixtures/tripoint/duplicate-1002.json'
import duplicate1003 from '../../fixtures/tripoint/duplicate-1003.json'
import duplicate1005 from '../../fixtures/tripoint/duplicate-1005.json'
import inProgress1009 from '../../fixtures/tripoint/in-progress-1009.json'
import invalid502 from '../../fixtures/tripoint/invalid-502.json'

// Tripoint's rules as the plan states them (Phase 7, one home per partner, L89).
const ACCEPTED_CODES = [1000, 1001, 1013, 1014, 1015, 1016, 1017]
const tripointAccept: Signal[] = [
  { field: 'ok', equals: true },
  { field: 'data.createLead.resultCode', in: ACCEPTED_CODES },
]
const tripointDecline: Signal[] = [
  { field: 'data.createLead.resultCode', not_in: ACCEPTED_CODES },
  { field: 'details[].message', any_item_contains: 'Cannot return null for non-nullable field CreateLeadResponse.id' },
  { field: 'details[].message', any_item_word_prefix_ci: 'invalid' },
]

const sent = { sent: true, isHtml: false }
const outcomeOf = (status: number | null, body: unknown, opts = sent) =>
  evaluateSaleOutcome(tripointAccept, tripointDecline, status, body, opts.isHtml, opts.sent).outcome

describe('evaluateSaleOutcome on the captured Tripoint fixtures', () => {
  it('accepts a 1001 with ok true', () => {
    expect(outcomeOf(success1001.httpStatus, success1001.body)).toBe('accepted')
  })
  it.each([
    ['1002', duplicate1002],
    ['1003', duplicate1003],
    ['1005', duplicate1005],
    ['1009', inProgress1009],
  ])('declines a %s duplicate', (_code, fixture) => {
    expect(outcomeOf(fixture.httpStatus, fixture.body)).toBe('declined_by_buyer')
  })
  it('declines the invalid lead 502 through the word prefix operator, even though the status is 5xx', () => {
    expect(outcomeOf(invalid502.httpStatus, invalid502.body)).toBe('declined_by_buyer')
  })
})

/**
 * #1416: the class Salesforce records for a sale (Success, Duplicate, Fail) is
 * derived from the outcome and the buyer's own duplicate rules, so the response
 * and patch scripts read it from the winner rather than carrying Tripoint's code
 * mapping. A buyer with no duplicate rule reports every decline as Fail, which
 * is honest; nothing about a second buyer's codes is assumed.
 */
describe('responseClassOf: the Salesforce class of a sale, from the outcome and the duplicate rules', () => {
  const tripointDuplicate: Signal[] = [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }]

  it('an accepted sale is Success whatever the body says', () => {
    expect(responseClassOf('accepted', tripointDuplicate, success1001.body)).toBe('Success')
  })
  it('a decline matching a duplicate rule is Duplicate (the captured 1003)', () => {
    expect(responseClassOf('declined_by_buyer', tripointDuplicate, duplicate1003.body)).toBe('Duplicate')
  })
  it('a decline matching no duplicate rule is Fail (the captured invalid 502, and a 1002 the rule does not list)', () => {
    expect(responseClassOf('declined_by_buyer', tripointDuplicate, invalid502.body)).toBe('Fail')
    expect(responseClassOf('declined_by_buyer', tripointDuplicate, duplicate1002.body)).toBe('Fail')
  })
  it('a buyer with no duplicate rules reports every decline as Fail, never a guessed Duplicate', () => {
    expect(responseClassOf('declined_by_buyer', [], duplicate1003.body)).toBe('Fail')
  })
  it('a buyer error or an unknown outcome has no class: the buyer gave no answer to classify', () => {
    expect(responseClassOf('buyer_error', tripointDuplicate, null)).toBeNull()
    expect(responseClassOf('outcome_unknown', tripointDuplicate, { ok: true })).toBeNull()
  })
})

describe('evaluateSaleOutcome on shapes not observed in the window (synthetic bodies, labelled as such)', () => {
  it('declines the null id 502 fault through any_item_contains', () => {
    const synthetic = { ok: false, details: [{ message: 'Cannot return null for non-nullable field CreateLeadResponse.id within CreateLeadResponse' }] }
    expect(outcomeOf(502, synthetic)).toBe('declined_by_buyer')
  })
  it('cannot classify a 200 with no result code', () => {
    expect(outcomeOf(200, { ok: true, data: {} })).toBe('outcome_unknown')
  })
  it('cannot classify a 200 whose ok is not true even with an accepted code', () => {
    expect(outcomeOf(200, { ok: false, data: { createLead: { resultCode: 1001 } } })).toBe('outcome_unknown')
  })
  it('cannot classify a bare 504 with an empty body', () => {
    expect(outcomeOf(504, {})).toBe('outcome_unknown')
  })
  it('cannot classify a response that never arrived after the request was sent', () => {
    expect(outcomeOf(null, null)).toBe('outcome_unknown')
  })
  it('is a buyer error on a 4xx, because the lead was not processed', () => {
    expect(outcomeOf(404, { error: 'not found' })).toBe('buyer_error')
  })
  it('is a buyer error on an HTML block page whatever the status', () => {
    expect(outcomeOf(200, '<html><body>blocked</body></html>', { sent: true, isHtml: true })).toBe('buyer_error')
  })
  it('is a buyer error when the request was never sent, such as a missing credential', () => {
    expect(outcomeOf(null, null, { sent: false, isHtml: false })).toBe('buyer_error')
  })
})

describe('the accept rule is positive (L181, L72)', () => {
  it('never accepts with an empty accept list, even on a body Tripoint would call a success', () => {
    const r = evaluateSaleOutcome([], tripointDecline, 200, success1001.body, false, true)
    expect(r.outcome).toBe('outcome_unknown')
  })
  it('requires every accept rule, not any one of them', () => {
    const half = { ok: true, data: { createLead: { resultCode: 1003 } } }
    expect(outcomeOf(200, half)).toBe('declined_by_buyer')
    const other = { ok: false, data: { createLead: { resultCode: 1001 } } }
    expect(outcomeOf(200, other)).toBe('outcome_unknown')
  })
  it('names which accept rules failed when it does not accept', () => {
    const r = evaluateSaleOutcome(tripointAccept, [], 200, { ok: false, data: { createLead: { resultCode: 1001 } } }, false, true)
    expect(r.outcome).toBe('outcome_unknown')
    expect(r.acceptFailed).toEqual([0])
  })
})

describe('matchSignal keeps the behaviour the classifier had (moved code, same rules)', () => {
  it('a missing field never matches not_in', () => {
    expect(matchSignal({ field: 'data.createLead.resultCode', not_in: [1013] }, {})).toBe(false)
  })
  it('equals is loose across number and numeric string, either way', () => {
    expect(matchSignal({ field: 'code', equals: '1001' }, { code: 1001 })).toBe(true)
    expect(matchSignal({ field: 'code', equals: 1001 }, { code: '1001' })).toBe(true)
    expect(matchSignal({ field: 'flag', equals: true }, { flag: 'true' })).toBe(true)
  })
  it('in is loose the same way', () => {
    expect(matchSignal({ field: 'code', in: ['1000', '1013'] }, { code: 1013 })).toBe(true)
    expect(matchSignal({ field: 'code', in: ['1000', '1013'] }, { code: 1003 })).toBe(false)
  })
  it('contains only matches a string field', () => {
    expect(matchSignal({ field: 'note', contains: 'Duplicate' }, { note: 'Lead Processing Failed: Duplicate Lead' })).toBe(true)
    expect(matchSignal({ field: 'note', contains: 'Dup' }, { note: 42 })).toBe(false)
  })
  it('present reads absence as null or undefined', () => {
    expect(matchSignal({ field: 'a.b', present: true }, { a: { b: 0 } })).toBe(true)
    expect(matchSignal({ field: 'a.b', present: false }, { a: { b: null } })).toBe(true)
    expect(matchSignal({ field: 'a.b', present: true }, { a: {} })).toBe(false)
  })
  it('does not match a dot path when an intermediate level is missing', () => {
    expect(matchSignal({ field: 'data.createLead.resultCode', equals: 1001 }, { data: null })).toBe(false)
  })
  it('the array operators need an array at the [] segment and never match a plain string', () => {
    expect(matchSignal({ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }, { details: 'invalid' })).toBe(false)
    expect(matchSignal({ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }, { details: [{ message: '  INVALID phone' }] })).toBe(true)
    expect(matchSignal({ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }, { details: [{ message: 'invalidated later' }] })).toBe(false)
  })
  it('a signal with no operator matches nothing', () => {
    expect(matchSignal({ field: 'ok' }, { ok: true })).toBe(false)
  })
})

describe('getBodyField and looseEquals are exported for the classifier to import back', () => {
  it('walks dot paths and [] segments', () => {
    expect(getBodyField({ a: { b: [{ c: 1 }, { c: 2 }] } }, 'a.b[].c')).toEqual([1, 2])
    expect(getBodyField({ a: { b: 7 } }, 'a.b')).toBe(7)
    expect(getBodyField(null, 'a')).toBeUndefined()
    expect(getBodyField({ a: 1 }, '')).toBeUndefined()
  })
  it('looseEquals treats an empty string as not numeric', () => {
    expect(looseEquals(0, '')).toBe(false)
    expect(looseEquals('', 0)).toBe(false)
  })
})
