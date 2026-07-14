import { hasTimeoutWarning } from '@/lib/timeout-suggestion'
import { nodeTypeGetsTimeoutBadge } from '@/lib/timeout-badge'
import { NODE_WARNING_CLASS, nodeWarningVariant } from '@/lib/node-warning'
import { useTimeoutSuggestion } from './timeout-suggestions'

/**
 * Pulsing glow overlaid on a node card whenever it needs attention: an
 * unconfigured / invalid node (`hasError`) or a node whose timeout warrants the
 * corner TimeoutWarningBadge (same `hasTimeoutWarning` predicate, so the glow
 * and the badge can never disagree).
 *
 * The two conditions are unrelated and glow in different colors (#563): amber
 * for unconfigured, violet for a too-low timeout. They were identical amber,
 * which sent a user hunting through the Timeout section of a node whose only
 * problem was that it was empty. Hue says WHICH; the corner badge and its
 * tooltip say why, and the timeout badge's own red/amber tiering says how bad.
 *
 * Rendered by withNodeBadges as an absolute, inset-0 sibling of the card, so the
 * glow (a box-shadow, see globals.css) hugs the card edges and stays findable
 * when the workflow is zoomed out (the 20px corner badges are too small to spot
 * on a large flow). `pointer-events-none` so it never intercepts clicks (which is
 * also why the reason lives on the badge, not here); renders nothing when the
 * node is healthy.
 */
export function NodeWarningGlow({
  type,
  config,
  namespace,
  hasError,
}: {
  type: string
  config: Record<string, unknown> | undefined
  namespace?: string
  hasError?: boolean
}) {
  const suggestion = useTimeoutSuggestion(namespace)
  const timeoutWarn = nodeTypeGetsTimeoutBadge(type) && hasTimeoutWarning(type, config, suggestion)
  const variant = nodeWarningVariant(hasError, timeoutWarn)
  if (!variant) return null
  return (
    <div
      aria-hidden
      className={`${NODE_WARNING_CLASS[variant]} pointer-events-none absolute inset-0 rounded-lg`}
    />
  )
}
