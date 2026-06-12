/**
 * Aggregated slow-execution-spike detection — covers the count floor, the
 * fraction gate, and their interaction. Supabase + KV + Slack integration lives
 * in `runSlowExecutionCheck`; pure logic is tested here.
 */
import { describe, it, expect } from 'vitest'
import { detectSlowSpike, buildSlowDurations, MIN_SLOW_COUNT, SLOW_FRACTION_PCT } from '../slow-execution-rate'

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

// Issue #83: the monitor was blind to runs longer than its 5-min window (they
// leave the started_at window before completing). buildSlowDurations combines
// completed-in-window runs with the ongoing duration of in-flight runs, so a
// live hang is counted before it finishes.
describe('buildSlowDurations()', () => {
  const NOW = 1_000_000_000

  it('uses each completed run\'s final duration_ms', () => {
    const per = buildSlowDurations(
      [{ workflow_id: 'wf', duration_ms: 8000 }, { workflow_id: 'wf', duration_ms: 200 }],
      [],
      ['wf'],
      NOW,
    )
    expect(per.get('wf')).toEqual([8000, 200])
  })

  it('counts an in-flight run\'s ongoing duration (now - started_at)', () => {
    const startedAt = new Date(NOW - 8000).toISOString() // running for 8s
    const per = buildSlowDurations([], [{ workflow_id: 'wf', started_at: startedAt }], ['wf'], NOW)
    expect(per.get('wf')).toEqual([8000])
  })

  it('ignores rows for workflows that are not monitored', () => {
    const per = buildSlowDurations(
      [{ workflow_id: 'other', duration_ms: 9000 }],
      [{ workflow_id: 'other', started_at: new Date(NOW - 9000).toISOString() }],
      ['wf'],
      NOW,
    )
    expect(per.get('wf')).toEqual([])
    expect(per.has('other')).toBe(false)
  })

  it('a cluster of in-flight runs past the threshold fires a spike before any finishes', () => {
    // 5 runs each hung for 8s (> 5s threshold), none completed yet.
    const startedAt = new Date(NOW - 8000).toISOString()
    const running = Array.from({ length: 5 }, () => ({ workflow_id: 'wf', started_at: startedAt }))
    const per = buildSlowDurations([], running, ['wf'], NOW)
    const spike = detectSlowSpike(per.get('wf')!, THRESHOLD)
    expect(spike).not.toBeNull()
    expect(spike!.slowCount).toBe(5)
    expect(spike!.totalCount).toBe(5)
  })

  it('a fresh in-flight run (under threshold) counts toward total but not slow', () => {
    const per = buildSlowDurations(
      [],
      [
        ...Array.from({ length: 5 }, () => ({ workflow_id: 'wf', started_at: new Date(NOW - 8000).toISOString() })), // slow
        { workflow_id: 'wf', started_at: new Date(NOW - 100).toISOString() }, // just started
      ],
      ['wf'],
      NOW,
    )
    const spike = detectSlowSpike(per.get('wf')!, THRESHOLD)
    expect(spike!.slowCount).toBe(5)
    expect(spike!.totalCount).toBe(6)
  })
})
