/**
 * #1199: a minimum debt below which the tiered multiplier declines to bid.
 *
 * Salesforce books zero Tripoint revenue for a lead under $10,000 of debt: the
 * formula behind Lead.ExternalRevenue__c prices 0.0009 from $10,000 to $12,499,
 * 0.0012 from $12,500, and 0 below $10,000 (read from the org 2026-09-06, #1166).
 * Bidspoke's config had no floor, so default_multiplier applied all the way down
 * and Bidspoke could bid, and win the Main Flow race with, a lead Salesforce
 * books at $0. Six such Main Flow leads in the week to 2026-09-06.
 *
 * Small money, but the daily pricing check carried this permanently as a
 * `floor-not-modelled` note because Bidspoke had nothing to compare the floor
 * against, and a standing note is the kind of thing that stops being read (L36).
 * With a floor expressible, the two rules can actually agree, and a disagreement
 * becomes a real difference rather than a fact about the schema.
 */
import { describe, it, expect } from 'vitest'
import { tripointPricingDifferences, type TripointRule } from '../tripoint-pricing-drift'

/** The live Salesforce rule as read from the org on 2026-09-06. */
const SF: TripointRule = {
  floor: 10000,
  lowBand: { upTo: 12499, multiplier: 0.0009 },
  highBand: { from: 12500, multiplier: 0.0012 },
}

/** Bidspoke's config as it stands today, matching Salesforce on both bands. */
const agreeingConfig = (extra: Record<string, unknown> = {}) => ({
  pricing_mode: 'tiered_multiplier',
  source_field: 'context.finalDebt',
  tiers: [{ above: 12499, multiplier: 0.0012 }],
  default_multiplier: 0.0009,
  ...extra,
})

const codes = (c: { differences: { code: string }[]; notes: { code: string }[] }) => ({
  differences: c.differences.map((d) => d.code),
  notes: c.notes.map((n) => n.code),
})

describe('the floor is comparable once Bidspoke can express one (#1199)', () => {
  it('reports floor-not-modelled while the config declares no floor', () => {
    // The status quo, kept as a note rather than a difference: it is a gap in
    // what the two systems can say, not a number that drifted.
    const out = codes(tripointPricingDifferences(SF, agreeingConfig()))
    expect(out.notes).toContain('floor-not-modelled')
    expect(out.differences).toEqual([])
  })

  it('says nothing at all once the floor matches Salesforce', () => {
    // This is the point of the change: the standing note goes away, so the daily
    // check is silent when the two rules genuinely agree.
    const out = codes(tripointPricingDifferences(SF, agreeingConfig({ min_source_value: 10000 })))
    expect(out.notes).toEqual([])
    expect(out.differences).toEqual([])
  })

  it('reports a real difference when the floors disagree', () => {
    const out = codes(tripointPricingDifferences(SF, agreeingConfig({ min_source_value: 5000 })))
    expect(out.differences).toContain('floor-disagrees')
    expect(out.notes).not.toContain('floor-not-modelled')
  })

  it('names both floors in the message, so the reader can act without opening two systems', () => {
    const c = tripointPricingDifferences(SF, agreeingConfig({ min_source_value: 5000 }))
    const msg = c.differences.find((d) => d.code === 'floor-disagrees')!.message
    expect(msg).toContain('5,000')
    expect(msg).toContain('10,000')
  })

  it('a floor of zero is a declared floor, not an absent one', () => {
    // 0 must not be read as "unset" by a falsy check: declaring that every lead
    // is worth bidding on is a deliberate answer, and it disagrees with 10,000.
    const out = codes(tripointPricingDifferences(SF, agreeingConfig({ min_source_value: 0 })))
    expect(out.differences).toContain('floor-disagrees')
    expect(out.notes).not.toContain('floor-not-modelled')
  })

  it('still reports a band difference beside a floor difference, never only the first', () => {
    const cfg = agreeingConfig({ min_source_value: 5000, default_multiplier: 0.0009999 })
    const out = codes(tripointPricingDifferences(SF, cfg))
    expect(out.differences).toContain('floor-disagrees')
    expect(out.differences).toContain('low-multiplier-disagrees')
  })

  it('a non-numeric floor is not silently treated as no floor', () => {
    // A typo in the editor must not read as the safe default. It is unreadable
    // config, which the comparison already has a code for.
    const out = codes(tripointPricingDifferences(SF, agreeingConfig({ min_source_value: 'ten thousand' })))
    expect(out.differences).toContain('config-unreadable')
  })
})

/**
 * The resolver half: a floor is only real if it stops a bid.
 *
 * The comparison above can agree with Salesforce on paper while the resolver
 * goes on bidding below the floor, so the number that matters is what
 * evaluateTieredMultiplier returns for a lead under it.
 */
import { resolveTieredMultiplierBid } from '../../engine/bid-resolver'

/** Resolve a bid for a given debt against a config, with no network involved. */
function bidFor(debt: number, extra: Record<string, unknown> = {}): number | null {
  return resolveTieredMultiplierBid(
    { ...agreeingConfig(extra), source_field: 'trigger.payload.finalDebt' },
    { trigger: { payload: { finalDebt: debt } }, steps: {}, env: {} } as never,
  )
}

describe('the resolver refuses to bid below the floor (#1199)', () => {
  it('POSITIVE CONTROL: prices a lead at and above the floor', () => {
    // Without this the refusals below could pass on a config that prices nothing.
    expect(bidFor(10000, { min_source_value: 10000 })).toBeCloseTo(9, 6)
    expect(bidFor(20000, { min_source_value: 10000 })).toBeCloseTo(24, 6)
  })

  it('returns no bid below the floor', () => {
    expect(bidFor(9999, { min_source_value: 10000 })).toBeNull()
    expect(bidFor(0, { min_source_value: 10000 })).toBeNull()
  })

  it('treats the floor as inclusive, matching Salesforce reading debt >= 10000', () => {
    expect(bidFor(10000, { min_source_value: 10000 })).not.toBeNull()
    expect(bidFor(9999.99, { min_source_value: 10000 })).toBeNull()
  })

  it('bids all the way down when no floor is declared, as it does today', () => {
    // The floor is opt in: every partner without one must be unaffected.
    expect(bidFor(500)).toBeCloseTo(0.45, 6)
  })

  it('a floor of zero still refuses a negative debt but bids at zero', () => {
    expect(bidFor(0, { min_source_value: 0 })).toBe(0)
    expect(bidFor(-1, { min_source_value: 0 })).toBeNull()
  })

  it('ignores an unreadable floor rather than refusing every lead', () => {
    // A typo must not silently take the partner out of bidding entirely; the
    // comparison above is what reports it as unreadable config.
    expect(bidFor(20000, { min_source_value: 'ten thousand' })).toBeCloseTo(24, 6)
  })
})
