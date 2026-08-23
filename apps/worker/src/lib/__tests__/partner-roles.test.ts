import { describe, it, expect } from 'vitest'
import { PARTNER_TYPES, isPartnerType, isBuyerPartner, isSourcePartner } from '../partner-roles'

// #306 / ADR 0001. The vocabulary itself is pinned to the database CHECK by
// apps/web/src/lib/__guards__/worker/partner-type-vocabulary.test.ts, which is
// where the filesystem read has to live: this package targets the Workers
// runtime and has no node types. Here we only test the predicates.
describe('worker partner_type vocabulary (#306)', () => {
  it('offers exactly source, buyer and both', () => {
    expect([...PARTNER_TYPES]).toEqual(['source', 'buyer', 'both'])
  })

  it('accepts both', () => {
    expect(isPartnerType('both')).toBe(true)
  })

  it('rejects a value outside the vocabulary', () => {
    expect(isPartnerType('seller')).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(isPartnerType(undefined)).toBe(false)
    expect(isPartnerType(null)).toBe(false)
    expect(isPartnerType(3)).toBe(false)
  })
})

describe('worker partner role eligibility (#306)', () => {
  it('treats both as buyer-eligible and source-eligible', () => {
    expect(isBuyerPartner('both')).toBe(true)
    expect(isSourcePartner('both')).toBe(true)
  })

  it('keeps the single-role values single-role', () => {
    expect(isBuyerPartner('source')).toBe(false)
    expect(isSourcePartner('buyer')).toBe(false)
  })
})
