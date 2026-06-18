import { hasTimeoutWarning } from './timeout-suggestion'
import { nodeTypeGetsTimeoutBadge } from './timeout-badge'

export interface MinimapWarningNode {
  id: string
  type?: string
  data?: { namespace?: string; config?: Record<string, unknown> }
}

/**
 * Node ids that should be flagged on the minimap as needing attention:
 * unconfigured / invalid nodes (from the edit-mode validation set) plus
 * timeout-warning nodes (the same `hasTimeoutWarning` predicate the corner badge
 * and the NodeWarningGlow use). Mirrors the on-canvas glow so the overview map
 * lights up exactly the nodes that glow — findable when zoomed out.
 */
export function computeWarningNodeIds(
  nodes: MinimapWarningNode[],
  unconfiguredIds: Set<string>,
  suggestions: Map<string, { p99: number; max_ms: number } | undefined>,
): Set<string> {
  const ids = new Set<string>()
  for (const n of nodes) {
    if (unconfiguredIds.has(n.id)) {
      ids.add(n.id)
      continue
    }
    const type = n.type ?? ''
    const namespace = n.data?.namespace ?? ''
    if (nodeTypeGetsTimeoutBadge(type) && hasTimeoutWarning(type, n.data?.config, suggestions.get(namespace))) {
      ids.add(n.id)
    }
  }
  return ids
}
