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
