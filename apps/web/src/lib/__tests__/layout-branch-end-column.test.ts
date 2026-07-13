import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow } from '../layout'
import mainFlow from './fixtures/main-flow.json'

// Layout pins every branch_end into its branch's column (`ownPos.x = branchPos.x`),
// which is why a branch_end cannot be dragged: any manual move snaps back on the
// next layout pass. So the pin has to be RIGHT, or the node is stranded with no way
// for a user to fix it.
//
// In the real Main Flow, `branch_end_3` (Engine OK Branch End) renders ~3,800px to
// the right of its branch, and dragging it back does nothing. A toy graph does NOT
// reproduce this: dagre happens to put the end in the branch's column anyway, so the
// assertion passes vacuously whether or not the pin ran. Only the real graph shape,
// with its nesting and multiple convergences, exposes it, hence the fixture.
//
// The fixture is the saved definition of the live Main Flow (84 nodes, 109 edges).
interface DefNode {
  id: string
  type: string
  namespace: string
  position: { x: number; y: number }
  config: Record<string, unknown> | null
}
interface DefEdge {
  id: string
  source: string
  target: string
  source_handle: string | null
}
const def = mainFlow as { nodes: DefNode[]; edges: DefEdge[] }

// Mirrors WorkflowCanvas.defToNodes: rebuild the canvas nodes from the stored
// definition, re-deriving each end node's `_pairId` from the edges.
function buildCanvas(): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const pairByEnd = new Map<string, string>()
  for (const n of def.nodes) {
    if (n.type !== 'branch_end' && n.type !== 'parallel_end') continue
    const startType = n.type === 'parallel_end' ? 'parallel' : 'branch'
    const start = def.edges
      .filter((e) => e.target === n.id)
      .map((e) => byId.get(e.source))
      .find((x) => x?.type === startType)
    if (start) pairByEnd.set(n.id, start.id)
  }

  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    ...def.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        namespace: n.namespace,
        config: n.config ?? {},
        variables: {},
        ...(pairByEnd.has(n.id) ? { _pairId: pairByEnd.get(n.id) } : {}),
      },
    })),
  ]

  const trigger = def.nodes.find((n) => n.type === 'webhook' && n.namespace === 'send_salesforce')
  const edges: Edge[] = def.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.source_handle ? { sourceHandle: e.source_handle } : {}),
  }))
  // The canvas always wires the synthetic trigger into the first real node; the
  // fixture's own entry point is the constants node (nothing targets it).
  const targeted = new Set(def.edges.map((e) => e.target))
  const entry = def.nodes.find((n) => !targeted.has(n.id) && n.type !== 'branch_end')
  if (entry && entry.id !== trigger?.id) {
    edges.unshift({ id: 'trigger-edge', source: 'trigger', target: entry.id })
  }
  return { nodes, edges }
}

const find = (nodes: Node[], ns: string) =>
  nodes.find((n) => (n.data as { namespace?: string }).namespace === ns)!

describe('branch_end column pinning (real Main Flow)', () => {
  it('places every branch_end in its own branch column', () => {
    const { nodes, edges } = buildCanvas()
    const out = layoutWorkflow(nodes, edges)

    const stranded: string[] = []
    for (const n of out) {
      const pairId = (n.data as { _pairId?: string })._pairId
      if (n.type !== 'branch_end' || !pairId) continue
      const branch = out.find((b) => b.id === pairId)
      if (!branch) continue
      if (n.position.x !== branch.position.x) {
        const ns = (n.data as { namespace?: string }).namespace
        stranded.push(`${ns}: end x=${n.position.x} but branch x=${branch.position.x}`)
      }
    }
    expect(stranded).toEqual([])
  })

  it('puts Engine OK Branch End in the Engine OK Branch column', () => {
    const { nodes, edges } = buildCanvas()
    const out = layoutWorkflow(nodes, edges)
    expect(find(out, 'branch_end_3').position.x).toBe(find(out, 'engine_ok_branch').position.x)
  })
})
