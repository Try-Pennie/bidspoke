import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow, nodeWidth, nodeHeight } from '../layout'

// A node wired from a second, deeper path. Until #1499 every deeper parent was a
// "cross-link", drawn but kept out of dagre's ranking so the shared target stayed
// shallow. Dan reversed that on 2026-09-23 for every parent except a filter: a
// card now sits below every non-filter card that feeds it, so no line climbs back
// up. Measured on all 11 live workflows, only the Engine canvas moved and Main
// Flow kept its 4,464 px width, because its widening came from a filter fork,
// which is still a cross-link (tested below).
//
// Graph:
//   trigger -> start (branch: left | right)
//     left  -> L1 -> L2 -> L3   (a deep chain)
//     right -> R1               (a single shallow node)
//   cross-link: L3 -> R1        (deep node wires back to the shallow R1)
//
// R1 is fed by L3, a deeper non-filter parent, so it sits below L3.
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

// Count pairs of nodes whose rendered boxes overlap (the de-overlap pass should
// keep this at 0 — dagre + the post-dagre overrides can otherwise stack nodes).
function overlapCount(laid: Node[]): number {
  const boxes = laid.map((n) => ({ x: n.position.x, y: n.position.y, w: nodeWidth(n.type, n.data), h: nodeHeight(n.type) }))
  let c = 0
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 5) c++
    }
  return c
}

describe('cross-link layout', () => {
  it('places a node below a deeper non-filter parent that feeds it (#1499)', () => {
    const withX = build(true)
    const laidX = layoutWorkflow(withX.nodes, withX.edges)
    expect(y(laidX, 'R1')).toBeGreaterThan(y(laidX, 'L3'))
  })

  it('produces no overlapping nodes', () => {
    expect(overlapCount(layoutWorkflow(build(true).nodes, build(true).edges))).toBe(0)
    expect(overlapCount(layoutWorkflow(build(false).nodes, build(false).edges))).toBe(0)
  })

  // A filter forking into a node must not pull that node off its main chain —
  // the filter is ignored for shape, and the single-child chain P -> X stays
  // straight (X directly under P).
  it('keeps a chain straight under its parent when a filter forks into it', () => {
    const nodes: Node[] = [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'start', type: 'branch', position: { x: 0, y: 0 }, data: { config: { branches: [{ label: 'a' }, { label: 'b' }], use_else: false } } },
      { id: 'P', type: 'code', position: { x: 0, y: 0 }, data: {} },
      { id: 'X', type: 'code', position: { x: 0, y: 0 }, data: {} },
      { id: 'F', type: 'filter', position: { x: 0, y: 0 }, data: { config: { operation: 'continue_if', condition: { field: 'x', operator: 'eq', value: '1' } } } },
    ]
    const edges: Edge[] = [
      { id: 't', source: 'trigger', target: 'start' },
      { id: 'a', source: 'start', target: 'P', sourceHandle: 'a' },
      { id: 'px', source: 'P', target: 'X' },
      { id: 'b', source: 'start', target: 'F', sourceHandle: 'b' },
      { id: 'fork', source: 'F', target: 'X', sourceHandle: 'pass' },
    ]
    const laid = layoutWorkflow(nodes, edges)
    const cx = (id: string) => { const n = laid.find((m) => m.id === id)!; return n.position.x + 104 }
    expect(Math.abs(cx('X') - cx('P'))).toBeLessThan(40)
  })

  // A branch with only ONE of its arms wired (the other handle empty, plus the
  // backbone to branch_end) must keep that arm's child directly under its handle
  // — NOT recentered under the branch card. childrenOf() excludes the end node,
  // so this looks like a single-child linear chain to the straightening pass;
  // the multi-output guard keeps the child under the "Bid" handle (left).
  it('keeps a single wired branch arm under its handle, not recentered', () => {
    const center = (id: string, laid: Node[]) => {
      const n = laid.find((m) => m.id === id)!
      return n.position.x + nodeWidth(n.type, n.data) / 2
    }
    const nodes: Node[] = [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'br', type: 'branch', position: { x: 0, y: 0 }, data: { config: { branches: [{ label: 'Bid' }], else_label: 'No Bid', else_behavior: 'output' } } },
      { id: 'sf', type: 'salesforce', position: { x: 0, y: 0 }, data: {} },
      { id: 'br_end', type: 'branch_end', position: { x: 0, y: 0 }, data: { _pairId: 'br' } },
    ]
    const edges: Edge[] = [
      { id: 't', source: 'trigger', target: 'br' },
      { id: 'bid', source: 'br', target: 'sf', sourceHandle: 'Bid' },
      { id: 'backbone', source: 'br', target: 'br_end' },
      { id: 'sfend', source: 'sf', target: 'br_end' },
    ]
    const laid = layoutWorkflow(nodes, edges)
    // The "Bid" handle is the left (first) handle, so its child sits left of the
    // branch's center — it must NOT be recentered onto the branch's x.
    expect(center('sf', laid)).toBeLessThan(center('br', laid) - 40)
  })
})
