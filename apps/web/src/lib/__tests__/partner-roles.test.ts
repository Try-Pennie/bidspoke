import { describe, it, expect } from 'vitest'
import {
  PARTNER_TYPES,
  isBuyerPartner,
  isSourcePartner,
  partnerTypeLabel,
} from '../partner-roles'

// #306 / ADR 0001. A real company can both supply leads and bid as a buyer
// (Engine: free-leads inbound plus fallback buyer outbound), so `partner_type`
// gains a third value `both`. The role questions the UI actually asks are "may
// this partner receive bids" and "does this partner send us leads", and `both`
// must answer yes to each. These predicates are the single vocabulary every
// caller shares, so a new value cannot be handled one way in the partner form
// and another way on the canvas.
describe('partner roles — buyer eligibility', () => {
  it('treats a buyer partner as buyer-eligible', () => {
    expect(isBuyerPartner('buyer')).toBe(true)
  })

  it('treats a both partner as buyer-eligible', () => {
    expect(isBuyerPartner('both')).toBe(true)
  })

  it('does not treat a source-only partner as buyer-eligible', () => {
    expect(isBuyerPartner('source')).toBe(false)
  })
})

describe('partner roles — source eligibility', () => {
  it('treats a source partner as source-eligible', () => {
    expect(isSourcePartner('source')).toBe(true)
  })

  it('treats a both partner as source-eligible', () => {
    expect(isSourcePartner('both')).toBe(true)
  })

  it('does not treat a buyer-only partner as source-eligible', () => {
    expect(isSourcePartner('buyer')).toBe(false)
  })
})

describe('partner roles — vocabulary', () => {
  it('offers exactly source, buyer and both', () => {
    expect([...PARTNER_TYPES]).toEqual(['source', 'buyer', 'both'])
  })

  it('gives every value in the vocabulary a distinct human label', () => {
    const labels = PARTNER_TYPES.map(partnerTypeLabel)
    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(PARTNER_TYPES.length)
  })

  it('every value in the vocabulary is eligible for at least one role', () => {
    // A value nobody can act on would render a partner with no config sections
    // at all, which reads as a blank form rather than as a bad value.
    for (const t of PARTNER_TYPES) {
      expect(isBuyerPartner(t) || isSourcePartner(t)).toBe(true)
    }
  })
})
