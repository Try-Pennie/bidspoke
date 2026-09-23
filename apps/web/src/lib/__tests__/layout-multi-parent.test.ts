import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow, nodeWidth, nodeHeight } from '../layout'

// #1499, settled with Dan in three rendered design rounds on 2026-09-23:
//   1. A card sits below EVERY card that feeds it (filter forks excepted), so
//      no line climbs back up to reach it.
//   2. A card fed by more than one output of the same card sits centred under
//      those outputs; lines from other cards do not pull it across.
//
// The fixture is the Engine Bidding Workflow's shape: buyer_select's sold and
// no_sale both feed build_response_body, its not_applicable and deferred both
// feed tripoint_ping, and tripoint_ping feeds build_response_body too.
function engineShape(): { nodes: Node[]; edges: Edge[] } {
  const code = (id: string): Node => ({ id, type: 'code', position: { x: 0, y: 0 }, data: {} })
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    code('prospect_trades'),
    { id: 'bs', type: 'buyer_select', position: { x: 0, y: 0 }, data: { config: { mode: 'decide_only' } } },
    code('build_response_body'),
    code('tripoint_ping'),
    code('route_response'),
  ]
  const e = (id: string, source: string, target: string, sourceHandle?: string): Edge => ({ id, source, target, sourceHandle })
  const edges: Edge[] = [
    e('t', 'trigger', 'prospect_trades'),
    e('pb', 'prospect_trades', 'bs'),
    e('sold', 'bs', 'build_response_body', 'sold'),
    e('no_sale', 'bs', 'build_response_body', 'no_sale'),
    e('na', 'bs', 'tripoint_ping', 'not_applicable'),
    e('def', 'bs', 'tripoint_ping', 'deferred'),
    e('tp', 'tripoint_ping', 'build_response_body'),
    e('rr', 'build_response_body', 'route_response'),
  ]
  return { nodes, edges }
}

const byId = (laid: Node[], id: string) => laid.find((n) => n.id === id)!
const centreX = (n: Node) => n.position.x + nodeWidth(n.type, n.data) / 2
/** The absolute x of one of buyer_select's output handles, from the offsets the layout publishes. */
function handleX(laid: Node[], handle: string): number {
  const bs = byId(laid, 'bs')
  const offsets = (bs.data as { _handleOffsets?: number[] })._handleOffsets!
  return centreX(bs) + offsets[['sold', 'no_sale', 'not_applicable', 'deferred'].indexOf(handle)]
}

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

describe('a card with several parents (#1499)', () => {
  it('sits below every card that feeds it, so no line climbs back up', () => {
    const { nodes, edges } = engineShape()
    const laid = layoutWorkflow(nodes, edges)
    const tp = byId(laid, 'tripoint_ping')
    expect(byId(laid, 'build_response_body').position.y).toBeGreaterThanOrEqual(tp.position.y + nodeHeight(tp.type))
  })

  it('sits centred under two outputs of the same card that feed it', () => {
    const { nodes, edges } = engineShape()
    const laid = layoutWorkflow(nodes, edges)
    const mid = (handleX(laid, 'sold') + handleX(laid, 'no_sale')) / 2
    expect(centreX(byId(laid, 'build_response_body'))).toBeCloseTo(mid, 0)
  })

  it('applies the same centring to every such card, tripoint_ping included', () => {
    const { nodes, edges } = engineShape()
    const laid = layoutWorkflow(nodes, edges)
    const mid = (handleX(laid, 'not_applicable') + handleX(laid, 'deferred')) / 2
    expect(centreX(byId(laid, 'tripoint_ping'))).toBeCloseTo(mid, 0)
  })

  // The live Engine definition also carries a stray buyer_select edge on a
  // handle the node does not have ('output', #1493). It must not pull the card
  // across: a card is centred on the configured outputs feeding it (seen on the
  // live canvas 2026-09-23, tripoint_ping sat left of centre).
  it('ignores a stray edge on a handle the node does not have when centring', () => {
    const { nodes, edges } = engineShape()
    edges.push({ id: 'stray', source: 'bs', target: 'tripoint_ping', sourceHandle: 'output' })
    const laid = layoutWorkflow(nodes, edges)
    const mid = (handleX(laid, 'not_applicable') + handleX(laid, 'deferred')) / 2
    expect(centreX(byId(laid, 'tripoint_ping'))).toBeCloseTo(mid, 0)
  })

  it('carries the chain below a centred card with it', () => {
    const { nodes, edges } = engineShape()
    const laid = layoutWorkflow(nodes, edges)
    expect(centreX(byId(laid, 'route_response'))).toBeCloseTo(centreX(byId(laid, 'build_response_body')), 0)
  })

  it('overlaps no two cards', () => {
    const { nodes, edges } = engineShape()
    expect(overlapCount(layoutWorkflow(nodes, edges))).toBe(0)
  })
})
