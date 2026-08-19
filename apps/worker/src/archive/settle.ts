// The settle window: how long after an execution completes before its cost has
// been written by the tail consumer. An execution archived before it settles is
// archived without its cost, permanently.
//
// Nothing stamps WHEN the cost was written, so this cannot be measured
// retrospectively. It is measured forwards: sample recently completed
// executions by age and find the age beyond which all of them have their cost.

export interface SettleSample {
  ageMinutes: number
  hasCost: boolean
}

export interface SettleResult {
  sampled: number
  /** Age in minutes at or beyond which every sampled execution had its cost. */
  settledFromMinute: number | null
  /** Age of the oldest execution still missing its cost, or null if none were. */
  oldestUnsettledMinutes: number | null
  /** Present only when no window could be derived, saying which case it was. */
  reason?: string
}

export function measureSettle(samples: SettleSample[]): SettleResult {
  // Sampling nothing is its own outcome. Reporting it as a window of zero would
  // read as "the cost lands instantly", which is the most reassuring possible
  // rendering of a broken query.
  if (samples.length === 0) {
    return {
      sampled: 0,
      settledFromMinute: null,
      oldestUnsettledMinutes: null,
      reason: 'no executions sampled, so the settle window is unmeasured, not zero',
    }
  }

  const unsettled = samples.filter((s) => !s.hasCost)
  const oldestUnsettledMinutes = unsettled.length === 0
    ? null
    : Math.max(...unsettled.map((s) => s.ageMinutes))

  const settledOlder = samples
    .filter((s) => s.hasCost && (oldestUnsettledMinutes === null || s.ageMinutes > oldestUnsettledMinutes))
    .map((s) => s.ageMinutes)

  if (settledOlder.length === 0) {
    return {
      sampled: samples.length,
      settledFromMinute: null,
      oldestUnsettledMinutes,
      reason: 'every sampled execution older than the newest unsettled one was itself unsettled, so the sample never settled',
    }
  }

  return {
    sampled: samples.length,
    settledFromMinute: Math.min(...settledOlder),
    oldestUnsettledMinutes,
  }
}
