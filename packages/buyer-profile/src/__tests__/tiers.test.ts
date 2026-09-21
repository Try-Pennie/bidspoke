import { describe, expect, it } from 'vitest'
import { matchTier, priceForDebt, payoutCents, type Ladder, type PricingTier } from '../tiers'

// Geoff's worked example (Slack, 2026-09-21): "12,500 - 14,999 -> .0012 | 15,000+ -> .0013".
// Stored as half open ranges with an inclusive lower bound: [12500, 15000) and [15000, null).
const geoff: PricingTier[] = [
  { population: 'engine', debtFrom: 12500, debtTo: 15000, multiplier: 0.0012 },
  { population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0013 },
]

describe('priceForDebt over profile tiers (inclusive lower, exclusive upper)', () => {
  it('prices 14,999.99 in the lower tier', () => {
    expect(priceForDebt(geoff, 'engine', 1499999)).toEqual({ multiplier: 0.0012, payoutCents: 1800 })
  })
  it('prices exactly 15,000 in the upper tier, not the lower one', () => {
    expect(priceForDebt(geoff, 'engine', 1500000)).toEqual({ multiplier: 0.0013, payoutCents: 1950 })
  })
  it('has no price for 12,499.99, below the first tier', () => {
    expect(priceForDebt(geoff, 'engine', 1249999)).toBeNull()
  })
  it('has no price for a population the tiers do not cover', () => {
    expect(priceForDebt(geoff, 'main_flow', 2000000)).toBeNull()
  })
  it('does not depend on the order the tiers were stored in', () => {
    const reversed = [...geoff].reverse()
    expect(priceForDebt(reversed, 'engine', 1499999)?.multiplier).toBe(0.0012)
    expect(priceForDebt(reversed, 'engine', 1500000)?.multiplier).toBe(0.0013)
  })
})

describe('matchTier over the legacy above ladder (exclusive lower, inclusive upper)', () => {
  // The shape readTiers in bid-resolver.ts adapts its stored `above` tiers into.
  const legacy: Ladder<{ multiplier: number }> = [
    { lower: { value: 20000, inclusive: false }, upper: null, multiplier: 0.002 },
    { lower: { value: 12499, inclusive: false }, upper: { value: 20000, inclusive: true }, multiplier: 0.0012 },
  ]
  it('matches 12,499 to nothing, exactly as `value > above` does today', () => {
    expect(matchTier(legacy, 12499)).toBeNull()
  })
  it('matches 12,499.01 to the lower tier', () => {
    expect(matchTier(legacy, 12499.01)?.multiplier).toBe(0.0012)
  })
  it('matches exactly 20,000 to the lower tier, because the legacy boundary is exclusive above', () => {
    expect(matchTier(legacy, 20000)?.multiplier).toBe(0.0012)
  })
  it('matches 20,000.01 to the upper tier', () => {
    expect(matchTier(legacy, 20000.01)?.multiplier).toBe(0.002)
  })
  it('returns null on an empty ladder', () => {
    expect(matchTier([], 5)).toBeNull()
  })
  it('refuses a non finite value', () => {
    expect(matchTier(legacy, Number.NaN)).toBeNull()
    expect(matchTier(legacy, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('payoutCents is integer math on cents and millionths', () => {
  it('rounds to the nearest cent', () => {
    // 1,234,567 cents at 0.0012 is 1481.4804 cents
    expect(payoutCents(1234567, 0.0012)).toBe(1481)
  })
  it('never returns a fraction of a cent', () => {
    expect(Number.isInteger(payoutCents(999999, 0.000333))).toBe(true)
  })
  it('is zero for a zero multiplier', () => {
    expect(payoutCents(1500000, 0)).toBe(0)
  })
  it('does not drift on a float multiplier the way plain multiplication does', () => {
    // 0.0013 * 1500000 in floating point is 1950.0000000000002; the cents answer is exactly 1950
    expect(payoutCents(1500000, 0.0013)).toBe(1950)
  })
})
