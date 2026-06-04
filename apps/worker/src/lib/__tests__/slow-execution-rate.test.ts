/**
 * Aggregated slow-execution-spike detection — covers the count floor, the
 * fraction gate, and their interaction. Supabase + KV + Slack integration lives
 * in `runSlowExecutionCheck`; pure logic is tested here.
 */
import { describe, it, expect } from 'vitest'
import { detectSlowSpike, MIN_SLOW_COUNT, SLOW_FRACTION_PCT } from '../slow-execution-rate'

const THRESHOLD = 5000 // 5s

// n runs at `ms`, padded with `fastCount` runs well under threshold.
function runs(slowCount: number, slowMs: number, fastCount: number): number[] {
  return [
    ...new Array(slowCount).fill(slowMs),
    ...new Array(fastCount).fill(100),
  ]
}

describe('detectSlowSpike()', () => {
  it('returns null when no runs are slow', () => {
    expect(detectSlowSpike(runs(0, 0, 50), THRESHOLD)).toBeNull()
  })

  it('returns null when threshold is unset (0)', () => {
    expect(detectSlowSpike(runs(20, 9000, 0), 0)).toBeNull()
  })

  it('returns null on an empty window', () => {
    expect(detectSlowSpike([], THRESHOLD)).toBeNull()
  })

  it('fires when slow runs meet both the count floor and the fraction', () => {
    // 6 slow of 8 = 75% — over 50% and over the 5-count floor.
    const result = detectSlowSpike(runs(6, 9000, 2), THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(6)
    expect(result!.totalCount).toBe(8)
    expect(result!.slowestMs).toBe(9000)
  })

  it('does NOT fire on a tiny sample below the count floor (3 of 4)', () => {
    // 75% slow, but only 3 slow runs — under MIN_SLOW_COUNT.
    expect(MIN_SLOW_COUNT).toBeGreaterThan(3)
    expect(detectSlowSpike(runs(3, 9000, 1), THRESHOLD)).toBeNull()
  })

  it('does NOT fire on a steady trickle on a busy workflow (6 of 3000)', () => {
    // Meets the count floor (6 ≥ 5) but only 0.2% — under the fraction gate.
    expect(detectSlowSpike(runs(6, 9000, 2994), THRESHOLD)).toBeNull()
  })

  it('fires exactly at the count floor when the fraction also passes', () => {
    // MIN_SLOW_COUNT slow of (MIN_SLOW_COUNT * 2) = exactly 50%.
    const total = MIN_SLOW_COUNT * 2
    const result = detectSlowSpike(runs(MIN_SLOW_COUNT, 9000, total - MIN_SLOW_COUNT), THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(MIN_SLOW_COUNT)
  })

  it('does NOT fire just below the fraction gate', () => {
    // 5 slow of 11 = 45.5% — over the count floor, under 50%.
    expect(SLOW_FRACTION_PCT).toBe(50)
    expect(detectSlowSpike(runs(5, 9000, 6), THRESHOLD)).toBeNull()
  })

  it('treats a run exactly at the threshold as NOT slow (strict >)', () => {
    // All 10 runs sit exactly at the threshold — none exceed it.
    expect(detectSlowSpike(new Array(10).fill(THRESHOLD), THRESHOLD)).toBeNull()
  })

  it('reports median and slowest of the slow set only', () => {
    const result = detectSlowSpike([6000, 8000, 10000, 12000, 14000, 100], THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(5)
    expect(result!.slowestMs).toBe(14000)
    expect(result!.medianSlowMs).toBe(10000) // middle of [6,8,10,12,14]k
  })

  it('honors custom floor and fraction overrides', () => {
    // 2 slow of 10 = 20%; passes with floor=2, fraction=10.
    const result = detectSlowSpike(runs(2, 9000, 8), THRESHOLD, 2, 10)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(2)
  })
})
