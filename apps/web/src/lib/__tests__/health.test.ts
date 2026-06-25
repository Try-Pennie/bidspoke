import { describe, it, expect } from 'vitest'
import { DEGRADED_WARN_RATE, isDegradedElevated, degradedPct } from '../health'

// #356: a small share of 'degraded' runs (lead served, post-response Salesforce
// writeback failed) keeps the success rate green, so the dashboard warns via a
// dedicated banner once the degraded share crosses the threshold.
describe('isDegradedElevated (#356)', () => {
  it('is false when there are no runs', () => {
    expect(isDegradedElevated(0, 0)).toBe(false)
    expect(isDegradedElevated(5, 0)).toBe(false)
  })

  it('is false below the threshold', () => {
    // 4 of 100 = 4% < 5%
    expect(isDegradedElevated(4, 100)).toBe(false)
  })

  it('is true at and above the threshold', () => {
    expect(isDegradedElevated(5, 100)).toBe(true) // exactly 5%
    expect(isDegradedElevated(10, 100)).toBe(true)
  })

  it('uses the 5% threshold constant', () => {
    expect(DEGRADED_WARN_RATE).toBe(0.05)
  })

  it('is false when there are zero degraded runs', () => {
    expect(isDegradedElevated(0, 500)).toBe(false)
  })
})

describe('degradedPct (#356)', () => {
  it('rounds the degraded share to a whole percent', () => {
    expect(degradedPct(5, 100)).toBe(5)
    expect(degradedPct(1, 30)).toBe(3) // 3.33 -> 3
    expect(degradedPct(0, 0)).toBe(0)
  })
})
