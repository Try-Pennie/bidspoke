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
import { timeoutFloorMs, timeoutBelowFloor } from './timeout-floor'

/** The engine's default retries when a node doesn't configure them. */
export const DEFAULT_RETRIES = 2

/**
 * Whether a node's configured timeout warrants a warning — sub-floor, or below
 * the history-based suggestion. The single source of truth for both the corner
 * TimeoutWarningBadge and the node warning glow, so they can never disagree.
 * `suggestion` is the batched per-node stats (null when none / not yet loaded).
 */
export function hasTimeoutWarning(
  nodeType: string | undefined,
  config: Record<string, unknown> | undefined,
  suggestion: { p99: number; max_ms: number } | null | undefined
): boolean {
  if (timeoutBelowFloor(nodeType, config) != null) return true
  if (!suggestion) return false
  // An unset timeout means the engine default (30s), which can still sit below
  // the suggestion for a slow step.
  const effective = typeof config?.timeout_ms === 'number' ? config.timeout_ms : 30000
  const retries = typeof config?.retries === 'number' ? config.retries : DEFAULT_RETRIES
  return effective < suggestedTimeoutMs(nodeType, suggestion.p99, suggestion.max_ms, retries)
}

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
