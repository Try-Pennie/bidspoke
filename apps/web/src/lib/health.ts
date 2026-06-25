// Dashboard health signals (#356).
//
// 'degraded' runs (the lead was served, but the post-response Salesforce
// writeback failed) are NEUTRAL in the success rate, so a small degraded share
// keeps the rate green and a writeback outage can hide behind a healthy-looking
// dashboard. A dedicated banner warns once the degraded share crosses this
// threshold. Degraded normally runs at ~0% (0 over the last 30 days), so 5% is a
// clear signal, not noise.
export const DEGRADED_WARN_RATE = 0.05

export function isDegradedElevated(degraded: number, total: number): boolean {
  return total > 0 && degraded / total >= DEGRADED_WARN_RATE
}

export function degradedPct(degraded: number, total: number): number {
  return total > 0 ? Math.round((degraded / total) * 100) : 0
}
