/**
 * Volume anomaly detection — PRD Section 3.6
 * Covers: drop detection, spike detection, insufficient-data guard,
 * zero-baseline guard, threshold edge cases.
 */
import { describe, it, expect } from 'vitest'
import { detectAnomaly, MIN_BASELINE_DAYS } from '../volume-anomaly'

function buildCounts(days: string[], count: number): Record<string, number> {
  return Object.fromEntries(days.map((d) => [d, count]))
}

const YESTERDAY = '2026-04-07'
const BASELINE_DAYS = ['2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06']

describe('detectAnomaly()', () => {
  it('returns null when there are no anomalies (volume matches baseline)', () => {
    const counts = buildCounts([...BASELINE_DAYS, YESTERDAY], 100)
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('detects a drop when yesterday is below low threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 40  // 40% of 100 = drop (threshold: 50%)
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('drop')
    expect(result!.yesterdayCount).toBe(40)
    expect(result!.baselineAvg).toBe(100)
  })

  it('does NOT alert when yesterday is exactly at the low threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 50  // exactly 50% → not below threshold
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('detects a spike when yesterday exceeds high threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 250  // 250% of 100 = spike (threshold: 200%)
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('spike')
    expect(result!.yesterdayCount).toBe(250)
  })

  it('does NOT alert when yesterday is exactly at the high threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 200  // exactly 200% → not above threshold
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it(`returns null when baseline has fewer than ${MIN_BASELINE_DAYS} days`, () => {
    const counts: Record<string, number> = {
      '2026-04-05': 100,
      '2026-04-06': 100,
      [YESTERDAY]: 10,  // only 2 baseline days
    }
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('returns null when baseline average is zero (no prior traffic)', () => {
    const counts = buildCounts(BASELINE_DAYS, 0)
    counts[YESTERDAY] = 0
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('returns null when yesterday has no entries (treated as 0) but baseline is also 0', () => {
    const counts = buildCounts(BASELINE_DAYS, 0)
    // yesterday not in map — defaults to 0
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('treats missing yesterday key as 0 count', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    // yesterday omitted → 0/100 = 0% → drop
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.yesterdayCount).toBe(0)
  })

  it('respects custom threshold overrides', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 70  // 70% — OK at default 50%, but alert at custom 80%
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
    expect(detectAnomaly(counts, YESTERDAY, 80)).not.toBeNull()
    expect(detectAnomaly(counts, YESTERDAY, 80)!.kind).toBe('drop')
  })

  it('rounds baselineAvg in the result', () => {
    // 3 + 3 + 4 = 10 / 3 days = 3.33 → rounded to 3
    const counts: Record<string, number> = {
      '2026-04-04': 3,
      '2026-04-05': 3,
      '2026-04-06': 4,
      [YESTERDAY]: 0,  // will trigger drop
    }
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.baselineAvg).toBe(Math.round((3 + 3 + 4) / 3))
  })

  it('uses only the 7 most recent baseline days when more data is available', () => {
    // 8 baseline days (indices 0-7); yesterday is the measured day
    const counts: Record<string, number> = {}
    for (let i = 8; i >= 1; i--) {
      const d = new Date(new Date(YESTERDAY).getTime() - i * 86400000).toISOString().slice(0, 10)
      counts[d] = i === 8 ? 9999 : 100  // day-8 has outlier; should be excluded from 7-day window
    }
    counts[YESTERDAY] = 40  // drop vs 100 baseline
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.baselineAvg).toBe(100)  // outlier day-8 excluded
  })
})
