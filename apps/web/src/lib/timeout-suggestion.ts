// Suggested-timeout math, computed client-side from the shared batch stats so
// the canvas badge and the config panel derive their verdicts from the SAME
// numbers fetched at the SAME moment — a suggestion of 8000 at page load can't
// become 8001 by the time the panel opens. Stats refresh only on a new fetch
// (page load / cache expiry), which is the intended "recompute later".
//
// MIRROR of apps/worker/src/lib/timeout-suggestion.ts (the source of truth,
// still used by the audit and the per-node fallback endpoint). The two apps
// share no package, so __tests__/timeout-suggestion-sync.test.ts imports both
// and fails CI if they diverge.
import { timeoutFloorMs } from './timeout-floor'

/** The engine's default retries when a node doesn't configure them. */
export const DEFAULT_RETRIES = 2

export function roundUpSmart(ms: number): number {
  if (ms <= 100) return Math.ceil(ms / 5) * 5
  if (ms <= 1000) return Math.ceil(ms / 50) * 50
  return Math.ceil(ms / 250) * 250
}

export function suggestedTimeoutMs(
  nodeType: string | undefined,
  p99: number,
  maxMs: number,
  retries: number
): number {
  const floor = timeoutFloorMs(nodeType)
  const raw =
    retries >= 1
      ? Math.max(p99 * 1.5, floor)
      : Math.max(p99 * 1.5, maxMs * 1.05, floor)
  return roundUpSmart(raw)
}

/**
 * Red threshold: below it, runs don't just lose headroom — they time out in
 * practice (below p99 with retries, below max without).
 */
export function redThresholdMs(p99: number, maxMs: number, retries: number): number {
  return retries >= 1 ? p99 : maxMs
}
