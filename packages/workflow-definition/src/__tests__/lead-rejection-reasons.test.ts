import { describe, it, expect } from 'vitest'
import { LEAD_REJECTION_REASONS, isLeadRejectionReason, missingRejectionReasons } from '../lead-rejection-reasons'

// #2588, part of #935. The reasons a lead validation step may send back to a
// partner. Partners match on the exact text, so the list is append only: these
// tests fail on a reason removed, respelled or reordered, and allow one added at
// the end.

// The list as first declared on 2026-10-21, read from the live
// validate_bidding_and_state scripts of RML GigFi (md5 bfc762b1...), RML
// LendSwift (c1a20b9f...) and Lead Economy (ec51b792...). Append to the real list,
// never edit this copy: it is the record of what was promised.
const FIRST_DECLARED = [
  'bidding not active',
  'ineligible state',
  'invalid name',
  'loan amount exceeds maximum',
  'military status ineligible',
  'unqualified',
  'employment status missing',
  'missing phone',
  'unqualified_lead',
]

describe('LEAD_REJECTION_REASONS', () => {
  it('begins with every reason first declared, in the same order and spelling (append only)', () => {
    expect(LEAD_REJECTION_REASONS.slice(0, FIRST_DECLARED.length)).toEqual(FIRST_DECLARED)
  })

  it('keeps both unqualified spellings, because GigFi and Lead Economy each send their own', () => {
    expect(LEAD_REJECTION_REASONS).toContain('unqualified')
    expect(LEAD_REJECTION_REASONS).toContain('unqualified_lead')
  })

  it('has no duplicates and no padding', () => {
    expect(new Set(LEAD_REJECTION_REASONS).size).toBe(LEAD_REJECTION_REASONS.length)
    for (const r of LEAD_REJECTION_REASONS) expect(r).toBe(r.trim())
  })

  it('isLeadRejectionReason matches exact spelling only', () => {
    expect(isLeadRejectionReason('invalid name')).toBe(true)
    for (const bad of ['Invalid name', 'invalid name ', 'invalid_name', '', 'constructor', undefined, 7]) {
      expect(isLeadRejectionReason(bad)).toBe(false)
    }
  })
})

describe('missingRejectionReasons', () => {
  it('names each used reason the list does not hold, once, in the order first used', () => {
    expect(missingRejectionReasons(['invalid name', 'gone', 'other', 'gone'], ['invalid name'])).toEqual(['gone', 'other'])
  })

  it('is empty when every used reason is listed', () => {
    expect(missingRejectionReasons(['invalid name', 'unqualified'])).toEqual([])
  })

  it('reports a reason removed from the real list (the guard seen to fail)', () => {
    const withoutOne = LEAD_REJECTION_REASONS.filter((r) => r !== 'missing phone')
    expect(missingRejectionReasons(['missing phone', 'invalid name'], withoutOne)).toEqual(['missing phone'])
  })
})
