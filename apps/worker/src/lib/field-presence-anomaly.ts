// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import { MIN_BASELINE_DAYS } from './volume-anomaly'

export { MIN_BASELINE_DAYS }
export const BASELINE_MIN_DAY_RUNS = 10
export const STABLE_MEAN_MIN = 0.98
export const STABLE_STDDEV_MAX = 0.02
export const COLLAPSE_K = 4
export const MIN_TODAY_SAMPLE = 20
export const DEAD_WINDOW_DAYS = 7
export const DEAD_MIN_RUNS = 200
export const DEAD_MAX_RATE = 0.005

export function dailyRate(ran: number, present: number): number {
  return ran > 0 ? present / ran : 0
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

export function stddev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length
  return Math.sqrt(variance)
}

// A field is "stable" when it is essentially always present with low variance
// over enough days. Variable fields (no-bid, no-debt) have high variance and
// never qualify, so they never page.
export function isStableBaseline(rates: number[]): boolean {
  return (
    rates.length >= MIN_BASELINE_DAYS &&
    mean(rates) >= STABLE_MEAN_MIN &&
    stddev(rates) <= STABLE_STDDEV_MAX
  )
}

// Tier-1: a stable field whose today's rate falls well below its stable band,
// with enough runs today to judge. Returns the baseline stats on a hit.
export function detectDrought(
  baselineRates: number[],
  todayRate: number,
  todayRan: number,
): { mean: number; stddev: number; todayRate: number } | null {
  if (todayRan < MIN_TODAY_SAMPLE) return null
  if (!isStableBaseline(baselineRates)) return null
  const m = mean(baselineRates)
  const sd = stddev(baselineRates)
  if (todayRate < m - COLLAPSE_K * sd) {
    return { mean: m, stddev: sd, todayRate }
  }
  return null
}

// Tier-2: many runs over the window, presence rate ~0, and never healthy on any
// day. The "never healthy" guard is what distinguishes born-dead (Tier-2) from
// was-healthy-then-died (Tier-1's collapse).
export function detectDayOneDead(
  windowRan: number,
  windowPresent: number,
  everHealthy: boolean,
): boolean {
  if (windowRan < DEAD_MIN_RUNS) return false
  if (everHealthy) return false
  return dailyRate(windowRan, windowPresent) <= DEAD_MAX_RATE
}
