import type { Edge } from '@xyflow/react'

// Recompute the edge set after deleting a set of nodes.
//
// Edges touching a deleted node are dropped, then each surviving upstream
// source is spliced to each surviving downstream target so the flow stays
// connected across the gap. The splice preserves the upstream edge's
// sourceHandle (defaulting to 'output'): a deletion on a branch/filter arm
// would otherwise produce a handle-less splice that the engine never follows —
// it routes multi-output nodes strictly by source_handle — silently
// dead-ending that arm at runtime while the canvas still renders it connected.
export function computeEdgesAfterDelete(edges: Edge[], idsToRemove: Set<string>): Edge[] {
  // Per surviving upstream source, the handle of the (first) edge that pointed
  // INTO the deleted subtree.
  const upstreamHandleBySource = new Map<string, string>()
  const downstreamTargets = new Set<string>()

  for (const e of edges) {
    if (idsToRemove.has(e.target) && !idsToRemove.has(e.source)) {
      if (!upstreamHandleBySource.has(e.source)) {
        upstreamHandleBySource.set(e.source, e.sourceHandle ?? 'output')
      }
    }
    if (idsToRemove.has(e.source) && !idsToRemove.has(e.target)) {
      downstreamTargets.add(e.target)
    }
  }

  const keptEdges = edges.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target))

  const spliceEdges: Edge[] = []
  for (const [source, sourceHandle] of upstreamHandleBySource) {
    for (const target of downstreamTargets) {
      const already = keptEdges.some(
        (e) => e.source === source && e.target === target && (e.sourceHandle ?? 'output') === sourceHandle,
      )
      if (already) continue
      spliceEdges.push({
        id: `splice-${source}-${sourceHandle}-${target}`,
        source,
        target,
        sourceHandle,
      })
    }
  }

  return [...keptEdges, ...spliceEdges]
}
