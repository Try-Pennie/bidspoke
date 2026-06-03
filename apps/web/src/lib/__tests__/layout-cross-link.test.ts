import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow } from '../layout'

// A node deliberately wired from a second, deeper path (a "cross-link") must be
// DRAWN but must not drive dagre's ranking — otherwise the shared target is
// forced to a deep rank to satisfy the long edge and the whole graph stretches
// sideways. See the FANOUT/cross-edge handling in layout.ts.
//
// Graph:
//   trigger -> start (branch: left | right)
//     left  -> L1 -> L2 -> L3   (a deep chain)
//     right -> R1               (a single shallow node)
//   cross-link: L3 -> R1        (deep node wires back to the shallow R1)
//
// Without the cross-link exclusion, R1 gets pushed below L3 (its rank must
// exceed L3's), the start->R1 edge becomes long, and the layout sprawls.
function build(withCrossLink: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    { id: 'start', type: 'branch', position: { x: 0, y: 0 }, data: { config: { branches: [{ label: 'left' }, { label: 'right' }], use_else: false } } },
    { id: 'L1', type: 'code', position: { x: 0, y: 0 }, data: {} },
    { id: 'L2', type: 'code', position: { x: 0, y: 0 }, data: {} },
    { id: 'L3', type: 'code', position: { x: 0, y: 0 }, data: {} },
    { id: 'R1', type: 'code', position: { x: 0, y: 0 }, data: {} },
  ]
  const edges: Edge[] = [
    { id: 't', source: 'trigger', target: 'start' },
    { id: 'a', source: 'start', target: 'L1', sourceHandle: 'left' },
    { id: 'b', source: 'L1', target: 'L2' },
    { id: 'c', source: 'L2', target: 'L3' },
    { id: 'd', source: 'start', target: 'R1', sourceHandle: 'right' },
  ]
  if (withCrossLink) edges.push({ id: 'x', source: 'L3', target: 'R1' })
  return { nodes, edges }
}

const y = (nodes: Node[], id: string) => nodes.find((n) => n.id === id)!.position.y

describe('cross-link layout', () => {
  it('keeps a cross-linked shallow node at its shallow rank', () => {
    const base = build(false)
    const withX = build(true)
    const laidBase = layoutWorkflow(base.nodes, base.edges)
    const laidX = layoutWorkflow(withX.nodes, withX.edges)

    // R1 should sit at roughly the same depth with or without the cross-link —
    // i.e. the cross-link did NOT drag it down below L3.
    expect(y(laidX, 'R1')).toBeLessThan(y(laidX, 'L3'))
    expect(y(laidX, 'R1')).toBeCloseTo(y(laidBase, 'R1'), -1)
  })
})
