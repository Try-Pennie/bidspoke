/** Send to receipt latency over a run's samples; null marks a sample that never arrived (L656). */
export interface LatencySummary {
  sent: number
  received: number
  lost: number
  minMs: number | null
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
}

/** Nearest rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(0, rank - 1)]
}

export function summarize(samples: Array<number | null>): LatencySummary {
  const got = samples.filter((s): s is number => s !== null).sort((a, b) => a - b)
  const empty = got.length === 0
  return {
    sent: samples.length,
    received: got.length,
    lost: samples.length - got.length,
    minMs: empty ? null : got[0],
    p50Ms: empty ? null : percentile(got, 50),
    p90Ms: empty ? null : percentile(got, 90),
    maxMs: empty ? null : got[got.length - 1],
  }
}
