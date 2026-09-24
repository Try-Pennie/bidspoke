import { describe, expect, it } from 'vitest'
import { soldOnPatch } from '../sold-on-switch'

describe('soldOnPatch', () => {
  it('clears every value a click buyer may not carry, so no refusal can name a hidden field', () => {
    expect(soldOnPatch('click')).toEqual({
      sold_on: 'click',
      hourly_lead_cap: null,
      hourly_spend_cap_cents: null,
      daily_spend_cap_cents: null,
      tiers: [],
    })
  })

  it('changes only the kind when switching to an offer buyer, whose fields are all shown', () => {
    expect(soldOnPatch('offer')).toEqual({ sold_on: 'offer' })
  })
})
