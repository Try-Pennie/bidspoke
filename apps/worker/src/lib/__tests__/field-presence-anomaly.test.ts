import { describe, it, expect } from 'vitest'
import {
  dailyRate, mean, stddev, isStableBaseline, detectDrought, detectDayOneDead,
  MIN_TODAY_SAMPLE, DEAD_MIN_RUNS,
} from '../field-presence-anomaly'

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
