/**
 * The tiered multiplier resolver walks the shared matchTier through an adapted
 * ladder (#1408, L370). These pin the adapter at the exact boundaries the legacy
 * `value > above` rule defined, so a change to the shared matcher or to the
 * adaptation shows up here rather than in Main Flow's Tripoint prices.
 */
import { describe, expect, it } from 'vitest'
import { resolveTieredMultiplierBid } from '../bid-resolver'
import type { ExecutionContext } from '../../types'

const ctx = (finalDebt: number): ExecutionContext => ({
  trigger: { payload: { finalDebt }, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'trace-1' },
  steps: {},
  env: {},
})

// Two tiers, stored in the order an author might type them (lowest first), so the
// adapter's own sort is exercised.
const cfg = {
  pricing_mode: 'tiered_multiplier',
  source_field: 'trigger.payload.finalDebt',
  tiers: [
    { above: 12499, multiplier: 0.0012 },
    { above: 20000, multiplier: 0.002 },
  ],
  default_multiplier: 0.0009,
}

describe('resolveTieredMultiplierBid through the shared ladder', () => {
  it('prices exactly 12,499 at the default, because the legacy lower bound is exclusive', () => {
    expect(resolveTieredMultiplierBid(cfg, ctx(12499))).toBeCloseTo(12499 * 0.0009, 6)
  })
  it('prices 12,499.01 in the first tier', () => {
    expect(resolveTieredMultiplierBid(cfg, ctx(12499.01))).toBeCloseTo(12499.01 * 0.0012, 6)
  })
  it('prices exactly 20,000 in the first tier, because the boundary belongs to the tier below it', () => {
    expect(resolveTieredMultiplierBid(cfg, ctx(20000))).toBeCloseTo(20000 * 0.0012, 6)
  })
  it('prices 20,000.01 in the top tier, which has no upper bound', () => {
    expect(resolveTieredMultiplierBid(cfg, ctx(20000.01))).toBeCloseTo(20000.01 * 0.002, 6)
    expect(resolveTieredMultiplierBid(cfg, ctx(5_000_000))).toBeCloseTo(5_000_000 * 0.002, 6)
  })
  it('ignores a malformed tier rather than failing the whole ladder', () => {
    const withJunk = { ...cfg, tiers: [...cfg.tiers, { above: 'x', multiplier: 9 }, null, 'tier'] }
    expect(resolveTieredMultiplierBid(withJunk, ctx(15000))).toBeCloseTo(15000 * 0.0012, 6)
  })
  it('falls back to the default multiplier when tiers is not an array', () => {
    expect(resolveTieredMultiplierBid({ ...cfg, tiers: 'none' }, ctx(15000))).toBeCloseTo(15000 * 0.0009, 6)
  })
})
