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
