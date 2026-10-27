/**
 * The chance of a count at least as far from a baseline share as the one seen
 * (#2851), which a rate check reads so a shift of a handful of events is not a page.
 */
import { describe, expect, it } from 'vitest'
import { chanceAtLeast, chanceAtMost } from '../binomial-tail'

describe('chanceAtMost() and chanceAtLeast(): the two tails of a binomial count', () => {
  it('matches the tails worked by hand', () => {
    // 10 fair coins: 0, 1 or 2 heads is (1 + 10 + 45) / 1024, and so is 8 or more.
    expect(chanceAtMost(2, 10, 0.5)).toBeCloseTo(56 / 1024, 12)
    expect(chanceAtLeast(8, 10, 0.5)).toBeCloseTo(56 / 1024, 12)
    expect(chanceAtMost(0, 10, 0.1)).toBeCloseTo(0.9 ** 10, 12)
  })

  it('stays a probability when the first term underflows a double', () => {
    // 0.7 ** 3000 is far below the smallest double, so it is summed in logs.
    const low = chanceAtMost(600, 3_000, 0.3)
    expect(low).toBeGreaterThan(0)
    expect(low).toBeLessThan(1e-30)
    expect(chanceAtMost(900, 3_000, 0.3)).toBeGreaterThan(0.4)
    expect(chanceAtMost(900, 3_000, 0.3)).toBeLessThan(0.6)
  })

  it('answers the edges without dividing by nothing', () => {
    expect(chanceAtMost(10, 10, 0.3)).toBe(1)
    expect(chanceAtMost(-1, 10, 0.3)).toBe(0)
    expect(chanceAtLeast(0, 10, 0.3)).toBe(1)
    expect(chanceAtLeast(11, 10, 0.3)).toBe(0)
    // A share of none: any count at all is impossible, none is certain.
    expect(chanceAtLeast(1, 10, 0)).toBe(0)
    expect(chanceAtMost(0, 10, 0)).toBe(1)
    // A share of all: anything short of every one is impossible.
    expect(chanceAtMost(9, 10, 1)).toBe(0)
    expect(chanceAtLeast(10, 10, 1)).toBe(1)
  })

  it('refuses a share or a count that is not one', () => {
    expect(() => chanceAtMost(2, 10, 1.5)).toThrow(/share/)
    expect(() => chanceAtMost(2, 10, Number.NaN)).toThrow(/share/)
    expect(() => chanceAtLeast(2, 2.5, 0.3)).toThrow(/count/)
  })
})
