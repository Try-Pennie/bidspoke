import { AlertTriangle } from 'lucide-react'
import { timeoutBelowFloor } from '@/lib/timeout-floor'
import { useTimeoutSuggestion } from './timeout-suggestions'

/**
 * Badge rendered in the bottom-left corner of a node whose configured timeout
 * needs attention. Two tiers, sub-floor taking priority:
 *
 *   red   — below the node-type reliability floor: a misconfig that fails on
 *           cold runs. Computed locally from the node config, no API needed.
 *   amber/red — below the history-based suggested value (from the batched
 *           timeout-suggestions context): slow runs hit the timeout and burn
 *           retries, or typical runs fail outright when the value sits below
 *           p99 (with retries) / max (without). Mirrors the config panel's
 *           red/amber thresholds so both surfaces agree.
 *
 * Shown in both view and edit mode so the issue is visible without opening the
 * node's config panel. Parent must be `relative`. Renders nothing when the
 * timeout clears both checks.
 */
export function TimeoutWarningBadge({
  type,
  config,
  namespace,
}: {
  type: string
  config: Record<string, unknown> | undefined
  namespace?: string
}) {
  const suggestion = useTimeoutSuggestion(namespace)

  const floor = timeoutBelowFloor(type, config)
  if (floor != null) {
    const timeout = config!.timeout_ms as number
    return (
      <Badge
        tone="red"
        title={`Timeout (${timeout}ms) is below the reliable minimum for this step (~${floor}ms). Cold runs exceed it on every retry, so the step times out and fails. Open the node and raise it to at least ${floor}ms.`}
      />
    )
  }

  if (!suggestion) return null
  // Mirror the config panel: an unset timeout means the engine default (30s),
  // which can still sit below the suggestion for a slow step.
  const effective = typeof config?.timeout_ms === 'number' ? config.timeout_ms : 30000
  // Compare against the tolerance threshold, not suggested_ms itself: the
  // suggestion is 1.5x a rolling p99, so a config sitting exactly at the
  // suggested value would otherwise flap in and out of warning as stats drift.
  if (effective >= (suggestion.warn_below_ms ?? suggestion.suggested_ms)) return null

  const fmt = (ms: number) => `${Math.round(ms).toLocaleString()}ms`
  const redThreshold = suggestion.retries >= 1 ? suggestion.p99 : suggestion.max_ms
  if (effective < redThreshold) {
    return (
      <Badge
        tone="red"
        title={`Timeout (${fmt(effective)}) is below what this step usually needs: most runs would time out (p99 ${fmt(suggestion.p99)} over ${suggestion.sample_size.toLocaleString()} runs). Try ${fmt(suggestion.suggested_ms)} for safety.`}
      />
    )
  }
  return (
    <Badge
      tone="amber"
      title={`Timeout (${fmt(effective)}) is below the suggested ${fmt(suggestion.suggested_ms)}: slower runs will time out and burn retries (p99 ${fmt(suggestion.p99)} over ${suggestion.sample_size.toLocaleString()} runs). Try ${fmt(suggestion.suggested_ms)} for more headroom.`}
    />
  )
}

function Badge({ tone, title }: { tone: 'red' | 'amber'; title: string }) {
  const classes =
    tone === 'red'
      ? 'border-red-300 bg-red-50 text-red-600'
      : 'border-amber-300 bg-amber-50 text-amber-600'
  return (
    <div
      title={title}
      className={`absolute -bottom-2 -left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm ${classes}`}
    >
      <AlertTriangle className="h-3 w-3" />
    </div>
  )
}
