import { hasTimeoutWarning } from './timeout-suggestion'
import { nodeTypeGetsTimeoutBadge } from './timeout-badge'
import { nodeWarningVariant, type NodeWarningVariant } from './node-warning'

export interface MinimapWarningNode {
  id: string
  type?: string
  data?: { namespace?: string; config?: Record<string, unknown> }
}

/**
 * Which nodes the minimap should flag, and WHY: unconfigured / invalid nodes (from
 * the edit-mode validation set) and timeout-warning nodes (the same
 * `hasTimeoutWarning` predicate the corner badge and the NodeWarningGlow use).
 *
 * Returns the variant per node, not a flat set (#656): the glow already
 * distinguishes the two conditions by hue, and a single-color minimap threw that
 * distinction away at exactly the zoom level where the minimap is what you're
 * reading. The variant, and its precedence (unconfigured wins over timeout), comes
 * from the shared `nodeWarningVariant`, so the glow, the badge and the minimap
 * cannot disagree about what a node's problem is.
 */
export function computeWarningVariants(
  nodes: MinimapWarningNode[],
  unconfiguredIds: Set<string>,
  suggestions: Map<string, { p99: number; max_ms: number } | undefined>,
): Map<string, NodeWarningVariant> {
  const variants = new Map<string, NodeWarningVariant>()
  for (const n of nodes) {
    const type = n.type ?? ''
    const timeoutWarn =
      nodeTypeGetsTimeoutBadge(type) &&
      hasTimeoutWarning(type, n.data?.config, suggestions.get(n.data?.namespace ?? ''))
    const variant = nodeWarningVariant(unconfiguredIds.has(n.id), timeoutWarn)
    if (variant) variants.set(n.id, variant)
  }
  return variants
}
