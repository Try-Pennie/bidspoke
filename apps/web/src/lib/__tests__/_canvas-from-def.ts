import type { Node, Edge } from '@xyflow/react'
import { nodeWidth, nodeHeight } from '../layout'

export interface DefNode { id: string; type: string; namespace: string; label?: string; position?: { x: number; y: number }; config: Record<string, unknown> | null }
export interface DefEdge { id: string; source: string; target: string; source_handle?: string | null }

/**
 * Rebuilds the canvas nodes and edges from a stored definition the way
 * WorkflowCanvas.defToNodes does, re-deriving each end node's `_pairId` from the
 * edges. Every real canvas fixture carries its own trigger edge.
 */
export function canvasFromDef(def: { nodes: DefNode[]; edges: DefEdge[] }): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const pairByEnd = new Map<string, string>()
  for (const n of def.nodes) {
    if (n.type !== 'branch_end' && n.type !== 'parallel_end') continue
    const startType = n.type === 'parallel_end' ? 'parallel' : 'branch'
    const start = def.edges.filter((e) => e.target === n.id).map((e) => byId.get(e.source)).find((x) => x?.type === startType)
    if (start) pairByEnd.set(n.id, start.id)
  }
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    ...def.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position ?? { x: 0, y: 0 },
      data: { namespace: n.namespace, config: n.config ?? {}, variables: {}, ...(pairByEnd.has(n.id) ? { _pairId: pairByEnd.get(n.id) } : {}) },
    })),
  ]
  const edges: Edge[] = def.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.source_handle ? { sourceHandle: e.source_handle } : {}) }))
  return { nodes, edges }
}

/** Every node reachable from the trigger over the edges. */
export function reachableIds(edges: Edge[]): Set<string> {
  const seen = new Set<string>(['trigger'])
  const queue = ['trigger']
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of edges) if (e.source === id && !seen.has(e.target)) { seen.add(e.target); queue.push(e.target) }
  }
  return seen
}

export const centreX = (n: Node) => n.position.x + nodeWidth(n.type, n.data) / 2

/**
 * Pairs of laid out cards whose drawn boxes overlap by more than a few pixels,
 * named by namespace. Orphans keep their manual positions, so only cards
 * reachable from the trigger are compared.
 */
export function overlaps(laid: Node[], edges: Edge[]): string[] {
  const live = reachableIds(edges)
  const boxes = laid.filter((n) => live.has(n.id)).map((n) => ({
    name: (n.data as { namespace?: string }).namespace ?? n.id,
    x: n.position.x, y: n.position.y, w: nodeWidth(n.type, n.data), h: nodeHeight(n.type),
  }))
  const out: string[] = []
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 5) out.push(`${a.name} x ${b.name}`)
    }
  return out
}

/** The drawn width of a laid out canvas, left edge of the leftmost reachable card to the right edge of the rightmost. */
export function canvasWidth(laid: Node[], edges: Edge[]): number {
  const live = reachableIds(edges)
  const shown = laid.filter((n) => live.has(n.id))
  const left = Math.min(...shown.map((n) => n.position.x))
  const right = Math.max(...shown.map((n) => n.position.x + nodeWidth(n.type, n.data)))
  return Math.round(right - left)
}
