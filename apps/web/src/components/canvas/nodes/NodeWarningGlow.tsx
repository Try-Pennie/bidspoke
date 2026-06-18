import { hasTimeoutWarning } from '@/lib/timeout-suggestion'
import { nodeTypeGetsTimeoutBadge } from '@/lib/timeout-badge'
import { useTimeoutSuggestion } from './timeout-suggestions'

/**
 * Pulsing amber glow overlaid on a node card whenever it needs attention — an
 * unconfigured / invalid node (`hasError`) or a node whose timeout warrants the
 * corner TimeoutWarningBadge (same `hasTimeoutWarning` predicate, so the glow
 * and the badge can never disagree).
 *
 * Rendered by withNodeBadges as an absolute, inset-0 sibling of the card, so the
 * glow (a box-shadow on `.node-warning`, see globals.css) hugs the card edges
 * and stays findable when the workflow is zoomed out — the 20px corner badge is
 * too small to spot on a large flow. `pointer-events-none` so it never
 * intercepts clicks; renders nothing when the node is healthy.
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
  if (!hasError && !timeoutWarn) return null
  return <div aria-hidden className="node-warning pointer-events-none absolute inset-0 rounded-lg" />
}
