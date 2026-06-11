/**
 * Shared timeout-suggestion math.
 *
 * Three consumers must agree on what "suggested" means so a node never shows a
 * warning in one surface and a clean bill in another:
 *   - GET /api/executions/step-duration-stats (config panel callout)
 *   - GET /api/workflows/:id/timeout-suggestions (canvas badges, batched)
 *   - the timeout audit (dashboard config-warnings panel + daily Slack cron)
 *
 * The math depends on whether the step retries on failure:
 *   retries == 0: must clear max x 1.05 — a single timeout = permanent fail.
 *   retries >= 1: drop the max-clamp; a long-tail outlier just retries.
 *                 Use p99 x 1.5 as the baseline (most calls succeed first try).
 * Never below the node-type floor: percentiles are computed over COMPLETED
 * steps, so any attempt slow enough to hit the current timeout is censored out
 * of the distribution — the floor is exactly the overhead the data can't see.
 */
import { suggestionFloorMs } from './timeout-floor'

/** The engine's default retries when a node doesn't configure them. */
export const DEFAULT_RETRIES = 2

/** Below this many completed runs, don't trust a suggestion at all. */
export const SUGGESTION_MIN_SAMPLE = 10

/**
 * Keep widening the sample window while a namespace has fewer completed runs
 * than this. A p99 needs a real tail to be meaningful — at 22 samples it's
 * basically the max of a quiet couple of hours, which is how a 700ms timeout
 * looked safe in the config panel while the day's history (p99 739ms) said
 * otherwise. High-volume namespaces clear this within the 2h window, so the
 * statement-timeout protection of the adaptive window is unchanged: only
 * low-volume namespaces widen, and their joins are cheap. Every surface
 * (config panel, canvas badge, audit) must use the same stop rule or they
 * disagree about the same node.
 */
export const SAMPLE_CONFIDENT = 200

/**
 * Only flag a timeout as under-provisioned when it sits below this fraction of
 * the suggested value. The suggestion is 1.5x a rolling p99, which drifts a few
 * percent run to run — without a tolerance band, a node configured exactly at
 * the suggested value (i.e. someone clicked the suggestion) flaps in and out of
 * warning as the sample rolls, and surfaces fetched at different moments (canvas
 * badge at page load, config panel on click) disagree about the same node.
 */
export const UNDER_PROVISION_TOLERANCE = 0.9

/** The compare-against value for under-provision warnings, with tolerance. */
export function warnBelowMs(suggestedMs: number): number {
  return Math.round(suggestedMs * UNDER_PROVISION_TOLERANCE)
}

// Round suggestions to readable increments that scale with magnitude. Without
// this a sub-100ms value would get rounded to 250ms (defeating the hard floor)
// and a 30s value would have noisy 250ms granularity.
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
  const floor = suggestionFloorMs(nodeType)
  const raw =
    retries >= 1
      ? Math.max(p99 * 1.5, floor)
      : Math.max(p99 * 1.5, maxMs * 1.05, floor)
  return roundUpSmart(raw)
}

/**
 * Mirror of the config panel's red threshold: below it, runs don't just lose
 * headroom — they time out in practice. With retries, current below p99 means
 * typical calls fail and burn retries every time; without retries, anything
 * below max means a real run would have failed.
 */
export function timeoutSeverity(
  configuredMs: number,
  p99: number,
  maxMs: number,
  retries: number
): 'red' | 'amber' {
  const redThreshold = retries >= 1 ? p99 : maxMs
  return configuredMs < redThreshold ? 'red' : 'amber'
}
