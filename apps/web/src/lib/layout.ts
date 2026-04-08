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
 * Auto-layout a React Flow graph top-to-bottom using dagre.
 * Returns a new nodes array with updated positions; edges are unchanged.
 */
export function layoutWorkflow(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 48, marginx: 60, marginy: 60 })

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_W, height: nodeHeight(node.type) })
  }

  for (const edge of edges) {
    // dagre only needs source→target, not handle ids
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const pos = g.node(node.id)
    // dagre positions are center-based; React Flow uses top-left
    return {
      ...node,
      position: {
        x: pos.x - NODE_W / 2,
        y: pos.y - nodeHeight(node.type) / 2,
      },
    }
  })
}
