import type { NodeDef, EdgeDef, WorkflowDef } from '@/types/workflow'

// Legacy-shape migrations applied to a raw workflow definition before it becomes
// React Flow nodes/edges. Both the initial canvas mount and version restore run
// this same pipeline (#114) — restoring an old version is precisely when legacy
// shapes (parallels without slot wires, branches without end pills) appear, and
// the two paths must never diverge or a restore-then-save persists a broken mix.

// Convert legacy `NodeDef.children: string[]` parallels into explicit fan-out
// edges (one `child-N` handle per child). Idempotent: skips a parallel that
// already has fan-out edges.
export function migrateParallelEdges(nodes: NodeDef[], edges: EdgeDef[]): EdgeDef[] {
  const parallelNodes = nodes.filter((n) => n.type === 'parallel' && (n.children?.length ?? 0) > 0)
  if (parallelNodes.length === 0) return edges

  let result = [...edges]

  for (const pNode of parallelNodes) {
    const childIds = new Set(pNode.children ?? [])
    // Already has fan-out edges — skip migration
    if (result.some((e) => e.source === pNode.id && (e.source_handle ?? '').startsWith('child-'))) continue

    // Remove sequential edges between children
    result = result.filter((e) => !(childIds.has(e.source) && childIds.has(e.target)))
    // Remove the old single sequential edge from parallel to its first child
    result = result.filter((e) => !(e.source === pNode.id && childIds.has(e.target)))

    // Add fan-out edges from parallel to each child
    const children = pNode.children ?? []
    for (let i = 0; i < children.length; i++) {
      result.push({
        id: `${pNode.id}-child-${i}`,
        source: pNode.id,
        target: children[i],
        source_handle: `child-${i}`,
      })
    }
  }

  return result
}

// Backfill branch_end nodes for any branch that doesn't already have one.
// Mirrors the parallel start/end pattern. The synthesized backbone edge is
// hidden but persists through save → load round-trips so the pairing
// sticks; the engine never traverses backbone edges (branch routing requires
// a `_route`-matched named handle), so this is safe for live workflows.
export function backfillBranchEnds(nodes: NodeDef[], edges: EdgeDef[]): { nodes: NodeDef[]; edges: EdgeDef[] } {
  const branchesNeedingEnd = nodes.filter((n) => {
    if (n.type !== 'branch') return false
    const incomingToEnds = edges
      .filter((e) => e.source === n.id)
      .map((e) => nodes.find((x) => x.id === e.target))
    return !incomingToEnds.some((t) => t?.type === 'branch_end')
  })
  if (branchesNeedingEnd.length === 0) return { nodes, edges }

  const usedNamespaces = new Set(nodes.map((n) => n.namespace))
  const newNodes: NodeDef[] = []
  const newEdges: EdgeDef[] = []
  for (const branch of branchesNeedingEnd) {
    const baseNs = `${branch.namespace}_end`
    let ns = baseNs
    let i = 2
    while (usedNamespaces.has(ns)) ns = `${baseNs}_${i++}`
    usedNamespaces.add(ns)
    const endId = crypto.randomUUID()
    newNodes.push({
      id: endId,
      namespace: ns,
      type: 'branch_end',
      position: { x: 0, y: 0 }, // dagre will place it on the next layout pass
      config: {},
      variables: {},
    })
    newEdges.push({
      id: crypto.randomUUID(),
      source: branch.id,
      target: endId,
      source_handle: 'output',
    })
  }
  return { nodes: [...nodes, ...newNodes], edges: [...edges, ...newEdges] }
}

// Run both migrations in the canonical order (backfill branch ends first, then
// migrate parallel children into fan-out edges) and return definition-shaped
// nodes/edges plus the trigger. defToNodes/defToEdges consume this.
export function migrateDefinition(
  definition: WorkflowDef | null | undefined
): { nodes: NodeDef[]; edges: EdgeDef[]; trigger: WorkflowDef['trigger'] | undefined } {
  const backfilled = backfillBranchEnds(definition?.nodes ?? [], definition?.edges ?? [])
  return {
    nodes: backfilled.nodes,
    edges: migrateParallelEdges(backfilled.nodes, backfilled.edges),
    trigger: definition?.trigger,
  }
}
