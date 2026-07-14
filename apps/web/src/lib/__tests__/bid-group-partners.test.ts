import { describe, it, expect } from 'vitest'
import { bidGroupPartnerSummary } from '../bid-group-partners'

// The card counted config.partner_ids (or the tiers' ids) and ignored
// config.fallback_partner_id, which the engine DOES call (bid-group.ts). A group
// with two partners and a fallback said "2 partners" while three could be hit (#645).

describe('bidGroupPartnerSummary', () => {
  it('counts the partners in a flat group', () => {
    expect(bidGroupPartnerSummary({ mode: 'highest_bid', partner_ids: ['a', 'b'] })).toBe('2 partners')
  })

  it('counts the fallback partner the engine can call', () => {
    expect(
      bidGroupPartnerSummary({ mode: 'highest_bid', partner_ids: ['a', 'b'], fallback_partner_id: 'f' }),
    ).toBe('2 partners + fallback')
  })

  it('counts partners across tiers in tiered mode', () => {
    const config = { mode: 'tiered', tiers: [{ partner_ids: ['a', 'b'] }, { partner_ids: ['c'] }] }
    expect(bidGroupPartnerSummary(config)).toBe('3 partners')
  })

  it('counts the fallback in tiered mode too', () => {
    const config = {
      mode: 'tiered',
      tiers: [{ partner_ids: ['a'] }],
      fallback_partner_id: 'f',
    }
    expect(bidGroupPartnerSummary(config)).toBe('1 partner + fallback')
  })

  it('singularizes one partner', () => {
    expect(bidGroupPartnerSummary({ mode: 'cascade', partner_ids: ['a'] })).toBe('1 partner')
  })

  it('reports a fallback-only group honestly rather than as empty', () => {
    expect(bidGroupPartnerSummary({ mode: 'highest_bid', partner_ids: [], fallback_partner_id: 'f' })).toBe(
      'Fallback partner only',
    )
  })

  it('says no partners are configured when none are', () => {
    expect(bidGroupPartnerSummary({ mode: 'highest_bid', partner_ids: [] })).toBe('No partners configured')
  })
})
