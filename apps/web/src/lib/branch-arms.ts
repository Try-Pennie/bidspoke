// Branch arm helpers (#95). A branch arm's label IS its edge sourceHandle and
// the engine's _route key, so two arms sharing a label make routing between them
// arbitrary. addBranch used `branch_${branches.length + 1}`, so deleting an arm
// and adding another reused a number. And removeBranch did no edge cleanup, so an
// arm's edges lingered in the saved definition (hidden from rendering only) and
// silently re-activated if a same-named arm reappeared.

export interface EdgeLike {
  id: string
  source: string
  sourceHandle?: string | null
}

/**
 * Smallest free `branch_N` label, avoiding both existing arm labels and any
 * handle already referenced by an edge from this node (so a new arm can't adopt
 * a stale edge's handle).
 */
export function nextBranchLabel(existingLabels: string[], usedHandles: string[] = []): string {
  const used = new Set<string>([...existingLabels, ...usedHandles])
  let n = 1
  while (used.has(`branch_${n}`)) n++
  return `branch_${n}`
}

/** Ids of edges from `nodeId` wired to `handle` — to delete when an arm is removed. */
export function armEdgeIds(edges: EdgeLike[], nodeId: string, handle: string): string[] {
  return edges
    .filter((e) => e.source === nodeId && e.sourceHandle === handle)
    .map((e) => e.id)
}
