/**
 * MONEY_GATE_DISPATCH_DELAY_MS, read once (#1796): how long the harness holds every
 * code dispatch, to prove a replay gives the same transcript however slow it runs.
 * Unset or empty is no delay. Anything else that is not a finite, non negative
 * number refuses by name, because a typo read as zero would run the proof undelayed
 * and report it as passed.
 */
export function parseDispatchDelay(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`money gate: MONEY_GATE_DISPATCH_DELAY_MS must be a number of milliseconds, not ${raw}`)
  }
  return ms
}
