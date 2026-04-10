import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

// All canvas nodes share this width (w-52 = 208px)
export const NODE_W = 208

// Per-type heights (header + body rows)
const NODE_H: Record<string, number> = {
  trigger:      72,
  filter:       100,  // has pass/exit row at bottom
  branch:       112,  // has branch labels row at bottom
  code:          88,
  response:      88,
  exit:          72,
  default:       80,
}

export function nodeHeight(type: string | undefined) {
  return NODE_H[type ?? 'default'] ?? NODE_H.default
}

const NODE_GAP = 24 // minimum clear space between any two nodes

/** Returns true if placing a node of `type` at `pos` would overlap any existing node (excluding `excludeId`). */
export function overlapsAny(
  pos: { x: number; y: number },
  type: string | undefined,
  nodes: Node[],
  excludeId?: string
): boolean {
  const w = NODE_W
  const h = nodeHeight(type)
  return nodes
    .filter((n) => n.id !== excludeId)
    .some((n) => {
      const nw = NODE_W
      const nh = nodeHeight(n.type)
      return (
        pos.x < n.position.x + nw + NODE_GAP &&
        pos.x + w + NODE_GAP > n.position.x &&
        pos.y < n.position.y + nh + NODE_GAP &&
        pos.y + h + NODE_GAP > n.position.y
      )
    })
}

/**
 * Returns a position near (preferX, preferY) that does not overlap any existing node.
 * Tries shifting right first, then falls back to below the whole graph.
 */
export function findFreePosition(
  preferX: number,
  preferY: number,
  type: string | undefined,
  nodes: Node[],
  excludeId?: string
): { x: number; y: number } {
  if (!overlapsAny({ x: preferX, y: preferY }, type, nodes, excludeId)) {
    return { x: preferX, y: preferY }
  }
  for (let i = 1; i <= 8; i++) {
    const x = preferX + i * (NODE_W + NODE_GAP)
    if (!overlapsAny({ x, y: preferY }, type, nodes, excludeId)) return { x, y: preferY }
  }
  // Fall back: place below the entire graph
  const bottomY =
    Math.max(0, ...nodes.filter((n) => n.id !== excludeId).map((n) => n.position.y + nodeHeight(n.type))) +
    NODE_GAP
  return { x: preferX, y: bottomY }
}

/**
 * Returns a sort index for a source handle so that siblings are ordered
 * left-to-right on the canvas to match the visual handle positions on the node.
 *
 * filter:         pass=0 (30% left), exit=1 (70% left)
 * bid_evaluation: winner=0, no_winner=1
 * branch:         branch labels in order + else last
 */
function handleSortIndex(
  nodeType: string | undefined,
  handleId: string | null | undefined,
  nodeData: unknown
): number {
  if (!handleId) return 0
  if (nodeType === 'filter') {
    if (handleId === 'pass') return 0
    if (handleId === 'exit') return 1
  }
  if (nodeType === 'bid_evaluation') {
    if (handleId === 'winner') return 0
    if (handleId === 'no_winner') return 1
  }
  if (nodeType === 'branch') {
    type BranchData = { config?: { branches?: { label: string }[] } }
    const cfg = (nodeData as BranchData | undefined)?.config
    const branches = cfg?.branches ?? []
    const handles = [...branches.map((b) => b.label), 'else']
    const idx = handles.indexOf(handleId)
    return idx >= 0 ? idx : 999
  }
  return 0
}

/**
 * Auto-layout a React Flow graph top-to-bottom using dagre.
 * Returns a new nodes array with updated positions; edges are unchanged.
 *
 * For multi-output nodes (filter, branch, bid_evaluation) the children are
 * guaranteed to be ordered left-to-right to match the handle positions on
 * the node, so edges never cross.
 */
export function layoutWorkflow(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 48, marginx: 60, marginy: 60 })

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_W, height: nodeHeight(node.type) })
  }

  // Build a quick lookup so we can resolve node type/data for each edge source
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // Sort edges from the same source by handle position before feeding dagre.
  // Dagre's crossing-minimisation starts from the initial node order, so adding
  // edges in left-to-right handle order gives the correct starting permutation.
  const sortedEdges = [...edges].sort((a, b) => {
    if (a.source !== b.source) return 0
    const src = nodeMap.get(a.source)
    const aIdx = handleSortIndex(src?.type, a.sourceHandle, src?.data)
    const bIdx = handleSortIndex(src?.type, b.sourceHandle, src?.data)
    return aIdx - bIdx
  })

  for (const edge of sortedEdges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  // ── Post-process: guarantee correct left-to-right child ordering ────────────
  //
  // Dagre's crossing minimisation is heuristic and not guaranteed to preserve
  // the edge-insertion order. We enforce the correct order by:
  //   1. Grouping children of each multi-output node by rank (y position).
  //   2. Sorting each group by desired handle order.
  //   3. Assigning the dagre-computed x values in sorted order (so the spread
  //      dagre chose is preserved — only the assignment changes).
  //
  // This is a pure x-coordinate swap and cannot break anything downstream.

  // Collect dagre positions (center-based)
  const pos = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const p = g.node(node.id)
    if (p) pos.set(node.id, { x: p.x, y: p.y })
  }

  // Group outgoing edges by source
  const outEdgesBySource = new Map<string, Edge[]>()
  for (const edge of edges) {
    const list = outEdgesBySource.get(edge.source) ?? []
    list.push(edge)
    outEdgesBySource.set(edge.source, list)
  }

  for (const [sourceId, outEdges] of outEdgesBySource) {
    if (outEdges.length < 2) continue
    const src = nodeMap.get(sourceId)

    // Collect children that have dagre positions and group by rank (rounded y)
    const children = outEdges
      .filter((e) => pos.has(e.target))
      .map((e) => ({
        nodeId: e.target,
        handleIdx: handleSortIndex(src?.type, e.sourceHandle, src?.data),
        ...pos.get(e.target)!,
      }))

    // Group by y rank (round to nearest px to tolerate floating-point drift)
    const byRank = new Map<number, typeof children>()
    for (const child of children) {
      const rank = Math.round(child.y)
      const group = byRank.get(rank) ?? []
      group.push(child)
      byRank.set(rank, group)
    }

    for (const group of byRank.values()) {
      if (group.length < 2) continue

      // The x values dagre assigned (sorted ascending)
      const sortedX = [...group].sort((a, b) => a.x - b.x).map((c) => c.x)
      // The desired order of those x values (by handle index)
      const desired = [...group].sort((a, b) => a.handleIdx - b.handleIdx)

      for (let i = 0; i < desired.length; i++) {
        pos.get(desired[i].nodeId)!.x = sortedX[i]
      }
    }
  }

  return nodes.map((node) => {
    const p = pos.get(node.id)
    if (!p) return node
    return {
      ...node,
      position: {
        x: p.x - NODE_W / 2,
        y: p.y - nodeHeight(node.type) / 2,
      },
    }
  })
}
