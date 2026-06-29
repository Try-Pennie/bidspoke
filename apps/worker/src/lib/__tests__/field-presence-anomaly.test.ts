import { describe, it, expect } from 'vitest'
import type { PresenceRow } from '../field-presence-anomaly'
import {
  dailyRate, mean, stddev, isStableBaseline, detectDrought, detectDayOneDead,
  findDroughts, findDayOneDead, MIN_TODAY_SAMPLE, DEAD_MIN_RUNS,
} from '../field-presence-anomaly'

const DMR = DEAD_MIN_RUNS

describe('numeric helpers', () => {
  it('dailyRate is present/ran', () => {
    expect(dailyRate(100, 99)).toBeCloseTo(0.99)
  })
  it('mean of one element', () => {
    expect(mean([0.99])).toBeCloseTo(0.99)
  })
  it('stddev is zero for constant input', () => {
    expect(stddev([0.99, 0.99, 0.99])).toBeCloseTo(0)
  })
  it('stddev is population stddev', () => {
    expect(stddev([0, 1])).toBeCloseTo(0.5)
  })
})

describe('isStableBaseline', () => {
  it('true for high-mean low-variance with enough days', () => {
    expect(isStableBaseline([0.99, 1, 0.99, 1])).toBe(true)
  })
  it('false when too few days', () => {
    expect(isStableBaseline([1, 1])).toBe(false)
  })
  it('false when mean is below the stable floor', () => {
    expect(isStableBaseline([0.5, 0.5, 0.5, 0.5])).toBe(false)
  })
  it('false when variance is high (a variable no-bid field)', () => {
    expect(isStableBaseline([1, 0.2, 0.9, 0.3])).toBe(false)
  })
})

describe('detectDrought', () => {
  const STABLE = [1, 0.99, 1, 0.99, 1]
  it('fires when a stable field collapses today with enough runs', () => {
    const r = detectDrought(STABLE, 0.0, 100)
    expect(r).not.toBeNull()
    expect(r!.todayRate).toBe(0)
  })
  it('does NOT fire when today has too few runs', () => {
    expect(detectDrought(STABLE, 0.0, MIN_TODAY_SAMPLE - 1)).toBeNull()
  })
  it('does NOT fire for a variable (no-bid) baseline even at 0% today', () => {
    expect(detectDrought([1, 0.2, 0.9, 0.3], 0.0, 100)).toBeNull()
  })
  it('does NOT fire when today is still within the stable band', () => {
    expect(detectDrought(STABLE, 0.99, 100)).toBeNull()
  })
  it('does NOT over-fire on a zero-variance baseline for a small dip (collapse floor)', () => {
    expect(detectDrought([1, 1, 1, 1, 1], 0.95, 100)).toBeNull()
  })
  it('fires on a zero-variance baseline for a real collapse below the floor', () => {
    expect(detectDrought([1, 1, 1, 1, 1], 0.5, 100)).not.toBeNull()
  })
})

describe('detectDayOneDead', () => {
  it('fires for many runs, ~0 presence, never healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, false)).toBe(true)
  })
  it('does NOT fire if the field was ever healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, true)).toBe(false)
  })
  it('does NOT fire with too few runs', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS - 1, 0, false)).toBe(false)
  })
})

function row(wf: string, field: string, day: string, ran: number, present: number): PresenceRow {
  return { workflow_id: wf, field_path: field, day, ran_count: ran, present_count: present }
}

const DAYS = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27']
const TODAY = '2026-06-29'

describe('findDroughts', () => {
  it('flags a stable field that collapses today, and ignores a normal no-bid field', () => {
    const rows: PresenceRow[] = []
    for (const d of DAYS) {
      rows.push(row('wf1', 'scout.final', d, 100, 100))   // stable, always present
      rows.push(row('wf1', 'bid.amount', d, 100, 40))     // no-bid: ~40%, low rate -> not stable
    }
    rows.push(row('wf1', 'scout.final', TODAY, 80, 0))    // collapsed today, enough runs
    rows.push(row('wf1', 'bid.amount', TODAY, 80, 0))     // 0% today but never stable
    const hits = findDroughts(rows, TODAY)
    expect(hits.map((h) => h.field_path)).toEqual(['scout.final'])
  })

  it('does not flag when today has too few runs', () => {
    const rows: PresenceRow[] = DAYS.map((d) => row('wf1', 'scout.final', d, 100, 100))
    rows.push(row('wf1', 'scout.final', TODAY, 5, 0))   // below MIN_TODAY_SAMPLE
    expect(findDroughts(rows, TODAY)).toEqual([])
  })
  it('skips a field that has baseline rows but no row for today', () => {
    const rows = DAYS.map((d) => row('wf1', 'scout.final', d, 100, 100))
    // no TODAY row for scout.final
    expect(findDroughts(rows, TODAY)).toEqual([])
  })
})

describe('findDayOneDead', () => {
  it('flags a field with many runs and zero presence, never healthy', () => {
    const rows = [row('wf2', 'eligibility.final', '2026-06-28', DMR, 0)]
    const hits = findDayOneDead(rows)
    expect(hits.map((h) => h.field_path)).toEqual(['eligibility.final'])
  })

  it('does not flag a field that was healthy on some day', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-27', 100, 100),  // healthy day
      row('wf2', 'eligibility.final', '2026-06-28', DMR, 0),
    ]
    expect(findDayOneDead(rows)).toEqual([])
  })
  it('does not mark everHealthy on a high-rate day with too few runs', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-26', 5, 5),      // 100% rate but only 5 runs (< floor) -> must NOT set everHealthy
      row('wf2', 'eligibility.final', '2026-06-28', 2000, 0),   // large dead day keeps window rate <= DEAD_MAX_RATE
    ]
    expect(findDayOneDead(rows).map((h) => h.field_path)).toEqual(['eligibility.final'])
  })
  it('does not flag day-one-dead just below the run floor', () => {
    expect(findDayOneDead([row('wf2', 'eligibility.final', '2026-06-28', DMR - 1, 0)])).toEqual([])
  })
})
