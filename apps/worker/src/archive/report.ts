// Measurement report for Phase A0. Every value here is a NUMBER by construction.
//
// The bundles being measured carry live SSNs, dates of birth, addresses and
// credit reports, and nothing upstream strips them, so this report is the leak
// surface. It reports sizes, counts and timings and nothing else, and its tests
// assert that structurally rather than by looking for a known string, because a
// blocklist only catches the values somebody thought of.

import type { EncodedBundle } from './bundle'

export interface Spread {
  p50: number
  p95: number
  p99: number
  max: number
}

export interface Report {
  count: number
  rawBytes: Spread
  gzipBytes: Spread
  wireBytes: Spread
  compressionRatio: Spread
  steps: { total: number; perExecution: Spread }
  cpuMs: { stringify: Spread; gzip: Spread; base64: Spread }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  }
}

export function summarize(measurements: EncodedBundle[]): Report {
  return {
    count: measurements.length,
    rawBytes: spread(measurements.map((m) => m.rawBytes)),
    gzipBytes: spread(measurements.map((m) => m.gzipBytes)),
    wireBytes: spread(measurements.map((m) => m.wireBytes)),
    compressionRatio: spread(measurements.map((m) => m.rawBytes / m.gzipBytes)),
    steps: {
      total: measurements.reduce((n, m) => n + m.stepCount, 0),
      perExecution: spread(measurements.map((m) => m.stepCount)),
    },
    cpuMs: {
      stringify: spread(measurements.map((m) => m.cpuMs.stringify)),
      gzip: spread(measurements.map((m) => m.cpuMs.gzip)),
      base64: spread(measurements.map((m) => m.cpuMs.base64)),
    },
  }
}
