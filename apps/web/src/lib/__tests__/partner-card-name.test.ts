import { describe, it, expect } from 'vitest'
import { partnerCardName } from '../partner-card-name'

// The card used to render config.partner_name, a copy of the name taken when the
// partner was first picked. The engine resolves the partner by config.partner_id
// against the live partners table and never reads that copy, so a rename left
// every Partner Bid node asserting a stale name forever (#645).

const PARTNERS = new Map([
  ['p1', { name: 'Tripoint' }],
  ['p2', { name: 'M1' }],
])

describe('partnerCardName', () => {
  it('shows the live partner name, not a stored copy', () => {
    expect(partnerCardName({ partnerId: 'p1', partners: PARTNERS, loaded: true })).toEqual({
      text: 'Tripoint',
      tone: 'normal',
    })
  })

  it('follows a rename, because it resolves by id every render', () => {
    const renamed = new Map([['p1', { name: 'Tripoint Lending' }]])
    expect(partnerCardName({ partnerId: 'p1', partners: renamed, loaded: true }).text).toBe('Tripoint Lending')
  })

  it('warns when the node points at a partner that no longer exists', () => {
    // The executor throws "Partner config not found" on this node at run time
    // (partner-bid.ts). The card should say so instead of showing a stale name.
    expect(partnerCardName({ partnerId: 'gone', partners: PARTNERS, loaded: true })).toEqual({
      text: 'Partner not found',
      tone: 'error',
    })
  })

  it('flags an unconfigured node with no partner at all', () => {
    expect(partnerCardName({ partnerId: undefined, partners: PARTNERS, loaded: true })).toEqual({
      text: 'No partner selected',
      tone: 'error',
    })
  })

  it('stays quiet while the partner list is still loading, rather than claiming not-found', () => {
    expect(partnerCardName({ partnerId: 'p1', partners: new Map(), loaded: false })).toEqual({
      text: '…',
      tone: 'muted',
    })
  })

  it('still reports a missing partner selection while loading', () => {
    // No partner_id needs no lookup, so the list being absent changes nothing.
    expect(partnerCardName({ partnerId: undefined, partners: new Map(), loaded: false }).tone).toBe('error')
  })
})
