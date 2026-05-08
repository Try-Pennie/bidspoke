/**
 * Real-time volume cliff detection — covers detection edge cases and threshold behavior.
 * Integration with Supabase + KV + Slack lives in `runVolumeCliffCheck`; tested by behavior
 * (cooldown, opt-out) once we wire E2E. Pure logic is tested here.
 */
import { describe, it, expect } from 'vitest'
import { detectCliff, BASELINE_WINDOW_MINUTES, RECENT_WINDOW_MINUTES, MIN_BASELINE_PER_MIN } from '../volume-cliff'

function buckets(baselinePerMin: number, recentTotal: number): number[] {
  const arr = new Array(60).fill(0)
  for (let i = 0; i < BASELINE_WINDOW_MINUTES; i++) arr[i] = baselinePerMin
  // distribute recentTotal evenly across the recent window
  const per = Math.floor(recentTotal / RECENT_WINDOW_MINUTES)
  let remainder = recentTotal - per * RECENT_WINDOW_MINUTES
  for (let i = BASELINE_WINDOW_MINUTES; i < 60; i++) {
    arr[i] = per + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder--
  }
  return arr
}

describe('detectCliff()', () => {
  it('returns null when recent matches baseline', () => {
    expect(detectCliff(buckets(70, 70 * 5))).toBeNull()
  })

  it('detects a cliff when last 5 min drops to zero', () => {
    const result = detectCliff(buckets(70, 0))
    expect(result).not.toBeNull()
    expect(result!.recentCount).toBe(0)
    expect(result!.baselinePerMin).toBe(70)
  })

  it('detects a cliff at 20% of expected (under 25% threshold)', () => {
    // baseline 70/min → expected 350 in 5min → 25% threshold = 87.5
    const result = detectCliff(buckets(70, 70))  // 70 in 5 min = 20%
    expect(result).not.toBeNull()
    expect(result!.recentCount).toBe(70)
  })

  it('does NOT alert at 30% of expected (above 25% threshold)', () => {
    expect(detectCliff(buckets(70, Math.ceil(70 * 5 * 0.3)))).toBeNull()
  })

  it('does NOT alert exactly at the 25% threshold (must be strictly below)', () => {
    expect(detectCliff(buckets(70, 70 * 5 * 0.25))).toBeNull()
  })

  it(`skips workflows with baseline below ${MIN_BASELINE_PER_MIN}/min (low-volume noise floor)`, () => {
    // baseline 5/min, recent 0 — would otherwise be a 100% drop
    expect(detectCliff(buckets(5, 0))).toBeNull()
  })

  it('uses median, not mean — robust to bursts', () => {
    // 54 minutes of 70/min, one burst of 1000, 5 minutes of 0
    const arr = new Array(60).fill(70)
    arr[0] = 1000  // outlier
    for (let i = 55; i < 60; i++) arr[i] = 0
    const result = detectCliff(arr)
    expect(result).not.toBeNull()
    expect(result!.baselinePerMin).toBe(70)  // median, not 88.7 mean
  })

  it('returns null when array length is wrong', () => {
    expect(detectCliff(new Array(30).fill(50))).toBeNull()
  })

  it('handles empty baseline correctly (median 0 → skipped)', () => {
    expect(detectCliff(new Array(60).fill(0))).toBeNull()
  })

  it('respects custom thresholds via parameters', () => {
    // baseline 70, recent 200 (~57% of expected); default threshold 25% → no alert
    expect(detectCliff(buckets(70, 200))).toBeNull()
    // bump threshold to 60% — same data should now alert
    expect(detectCliff(buckets(70, 200), 60)).not.toBeNull()
  })
})
