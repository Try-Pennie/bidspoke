import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow } from '../layout'
import { outputHandles } from '../handle-geometry'
import { centreX, overlaps } from './_canvas-from-def'

// The one child placement rule (#1576, milestone 55). A fixed width card (filter,
// buyer_click_check) with ONE wired output draws it at the centre with its child
// straight below; with both wired, the handles stay at the card's own fractions
// and the children spread into columns, so they never sit on each other (Dan,
// design round 3, 2026-09-25: "Spread, wires bend"). A cross-link arm counts as
// wired ("No, both count") but never moves the card it forks into (#1499).

type Arm = 'none' | 'child' | 'cross' | 'end'
const code = (id: string): Node => ({ id, type: 'code', position: { x: 0, y: 0 }, data: { namespace: id, config: {} } })

/**
 * trigger -> top (branch: a | b, no else) ; top.a -> F ; top.b -> P -> X ;
 * top -> top_end (backbone). F's arms go to their own child, fork into X (a
 * cross-link, since X's primary parent is P), or into top_end.
 */
function fixture(type: 'filter' | 'buyer_click_check', arms: [Arm, Arm]): { nodes: Node[]; edges: Edge[] } {
  const F: Node = { id: 'F', type, position: { x: 0, y: 0 }, data: { namespace: 'F', config: type === 'filter' ? { operation: 'continue_if' } : { partner_id: 'p' } } }
  const handles = outputHandles(F)
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    { id: 'top', type: 'branch', position: { x: 0, y: 0 }, data: { namespace: 'top', config: { branches: [{ label: 'a' }, { label: 'b' }], else_behavior: 'none' } } },
    { id: 'top_end', type: 'branch_end', position: { x: 0, y: 0 }, data: { namespace: 'top_end', _pairId: 'top' } },
    F, code('P'), code('X'),
  ]
  const edges: Edge[] = [
    { id: 't', source: 'trigger', target: 'top' },
    { id: 'ta', source: 'top', target: 'F', sourceHandle: 'a' },
    { id: 'tb', source: 'top', target: 'P', sourceHandle: 'b' },
    { id: 'px', source: 'P', target: 'X' },
    { id: 'backbone', source: 'top', target: 'top_end' },
  ]
  arms.forEach((arm, i) => {
    const h = handles[i]
    if (arm === 'child') { nodes.push(code(`C_${h}`)); edges.push({ id: `f_${h}`, source: 'F', target: `C_${h}`, sourceHandle: h }) }
    if (arm === 'cross') edges.push({ id: `f_${h}`, source: 'F', target: 'X', sourceHandle: h })
    if (arm === 'end') edges.push({ id: `f_${h}`, source: 'F', target: 'top_end', sourceHandle: h })
  })
  return { nodes, edges }
}

const byId = (laid: Node[], id: string) => laid.find((n) => n.id === id)!
const offsetsOf = (n: Node) => (n.data as { _handleOffsets?: number[] })._handleOffsets

// A cross-link is a filter fork only (crossEdgeIds), so the click check is walked
// without that arm; its fork into another path is an ordinary ranked parent.
const ARMS: Record<'filter' | 'buyer_click_check', Arm[]> = { filter: ['none', 'child', 'cross', 'end'], buyer_click_check: ['none', 'child', 'end'] }
const cases = (Object.keys(ARMS) as Array<keyof typeof ARMS>).flatMap((type) => ARMS[type].flatMap((a) => ARMS[type].map((b) => [type, a, b] as const)))

describe('a fixed width card, every combination of its two outputs', () => {
  it.each(cases)('%s with %s and %s lays out with no two cards overlapping', (type, a, b) => {
    const { nodes, edges } = fixture(type, [a, b])
    expect(overlaps(layoutWorkflow(nodes, edges), edges)).toEqual([])
  })

  it.each(cases)('%s with %s and %s draws a lone wired output at the centre, and both at the card fractions', (type, a, b) => {
    const { nodes, edges } = fixture(type, [a, b])
    const laid = layoutWorkflow(nodes, edges)
    const offsets = offsetsOf(byId(laid, 'F'))!
    const wired = [a, b].map((arm) => arm !== 'none')
    expect(offsets).toHaveLength(2)
    if (wired[0] && !wired[1]) expect(offsets[0]).toBe(0)
    if (wired[1] && !wired[0]) expect(offsets[1]).toBe(0)
    if (wired[0] === wired[1]) expect(offsets[0]).toBeLessThan(0)
    if (wired[0] === wired[1]) expect(offsets[1]).toBeGreaterThan(0)
  })

  it.each(cases.filter(([, a, b]) => [a, b].filter((x) => x === 'child').length === 1 && !(a === 'cross' || b === 'cross')))(
    '%s with %s and %s puts its lone real child straight below it',
    (type, a, b) => {
      const { nodes, edges } = fixture(type, [a, b])
      const laid = layoutWorkflow(nodes, edges)
      const h = outputHandles(byId(laid, 'F'))[a === 'child' ? 0 : 1]
      expect(Math.abs(centreX(byId(laid, `C_${h}`)) - centreX(byId(laid, 'F')))).toBeLessThan(1)
    },
  )

  it.each(['filter', 'buyer_click_check'] as const)('%s with both outputs wired spreads its children either side of it', (type) => {
    const { nodes, edges } = fixture(type, ['child', 'child'])
    const laid = layoutWorkflow(nodes, edges)
    const [h0, h1] = outputHandles(byId(laid, 'F'))
    expect(centreX(byId(laid, `C_${h0}`))).toBeLessThan(centreX(byId(laid, 'F')) - 100)
    expect(centreX(byId(laid, `C_${h1}`))).toBeGreaterThan(centreX(byId(laid, 'F')) + 100)
  })
})

/**
 * A filter on one arm of `top` forks into X, which its primary parent PB (a
 * branch, or a bid_group) places. The fork must leave X exactly where it was,
 * while the filter's own real child does move, because a wired cross-link arm
 * keeps its column reserved.
 */
function crossFixture(primary: 'branch' | 'bid_group', fork: boolean, filterFirst: boolean): { nodes: Node[]; edges: Edge[] } {
  const [armX, armY] = primary === 'branch' ? ['x', 'y'] : ['winner', 'no_winner']
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    // A bid_group splits the two paths: a branch here would align X, which both
    // its arms reach once the fork exists, under itself and hide the placement.
    { id: 'top', type: 'bid_group', position: { x: 0, y: 0 }, data: { namespace: 'top', config: {} } },
    { id: 'F', type: 'filter', position: { x: 0, y: 0 }, data: { namespace: 'F', config: { operation: 'continue_if' } } },
    primary === 'branch'
      ? { id: 'PB', type: 'branch', position: { x: 0, y: 0 }, data: { namespace: 'PB', config: { branches: [{ label: 'x' }, { label: 'y' }], else_behavior: 'none' } } }
      : { id: 'PB', type: 'bid_group', position: { x: 0, y: 0 }, data: { namespace: 'PB', config: {} } },
    code('C'), code('X'), code('Y'),
  ]
  const filterEdges: Edge[] = [
    { id: 'fc', source: 'F', target: 'C', sourceHandle: 'pass' },
    ...(fork ? [{ id: 'fork', source: 'F', target: 'X', sourceHandle: 'exit' }] : []),
  ]
  const primaryEdges: Edge[] = [
    { id: 'px', source: 'PB', target: 'X', sourceHandle: armX },
    { id: 'py', source: 'PB', target: 'Y', sourceHandle: armY },
  ]
  // Placement visits sources in the order their edges come, so a parent visited
  // later overwrites an earlier one: both orders are laid out, or the rule under
  // test would be the edge order.
  const edges: Edge[] = [
    { id: 't', source: 'trigger', target: 'top' },
    { id: 'ta', source: 'top', target: 'F', sourceHandle: 'winner' },
    { id: 'tb', source: 'top', target: 'PB', sourceHandle: 'no_winner' },
    ...(filterFirst ? [...filterEdges, ...primaryEdges] : [...primaryEdges, ...filterEdges]),
  ]
  return { nodes, edges }
}

const crossCases = (['branch', 'bid_group'] as const).flatMap((p) => [[p, 'the filter first'], [p, 'the primary parent first']] as const)
const laidCross = (primary: 'branch' | 'bid_group', fork: boolean, order: string) => {
  const { nodes, edges } = crossFixture(primary, fork, order === 'the filter first')
  return layoutWorkflow(nodes, edges)
}

describe('a filter forking into a card on another path (#1499)', () => {
  it.each(crossCases)('leaves the card its primary parent (a %s) placed exactly where it was, edges listing %s', (primary, order) => {
    expect(byId(laidCross(primary, true, order), 'X').position).toEqual(byId(laidCross(primary, false, order), 'X').position)
  })

  it.each(crossCases)('still moves the filter\'s own real child aside, with a %s as the primary parent, edges listing %s', (primary, order) => {
    const without = laidCross(primary, false, order)
    const withFork = laidCross(primary, true, order)
    expect(Math.abs(centreX(byId(without, 'C')) - centreX(byId(without, 'F')))).toBeLessThan(1)
    expect(centreX(byId(withFork, 'C'))).toBeLessThan(centreX(byId(withFork, 'F')) - 100)
  })
})

// #1581 said such a parallel's join was not pushed below its chains, and its
// chains were not ordered by slot, because two layout copies knew only child-N.
// Neither shows in a laid out canvas: measured 2026-09-25, the end cascade walks
// the slot handles itself and puts the join below the deepest chain, and the
// placement pass orders children by their columns, so reverting the synthetic
// rank edges to child-N moves nothing. This guards named slot parallels as a
// whole (nothing else lays one out): naming their handles child-N anywhere
// leaves both chains unplaced on top of each other.
describe('a parallel whose slots have their own names (#1581)', () => {
  it('pushes its join below both chains and orders the chains by slot', () => {
    const nodes: Node[] = [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'par', type: 'parallel', position: { x: 0, y: 0 }, data: { namespace: 'par', config: { children: [{ id: 'fast', label: 'Fast' }, { id: 'slow', label: 'Slow' }] } } },
      { id: 'par_end', type: 'parallel_end', position: { x: 0, y: 0 }, data: { namespace: 'par_end', _pairId: 'par' } },
      code('F1'), code('S1'), code('S2'), code('S3'),
    ]
    const edges: Edge[] = [
      { id: 't', source: 'trigger', target: 'par' },
      { id: 'backbone', source: 'par', target: 'par_end' },
      // Slow is added first, so only the slot order can put it on the right.
      { id: 'ps', source: 'par', target: 'S1', sourceHandle: 'slow' },
      { id: 's12', source: 'S1', target: 'S2' },
      { id: 's23', source: 'S2', target: 'S3' },
      { id: 'pf', source: 'par', target: 'F1', sourceHandle: 'fast' },
    ]
    const laid = layoutWorkflow(nodes, edges)
    expect(byId(laid, 'par_end').position.y).toBeGreaterThan(byId(laid, 'S3').position.y)
    expect(byId(laid, 'par_end').position.y).toBeGreaterThan(byId(laid, 'F1').position.y)
    expect(centreX(byId(laid, 'F1'))).toBeLessThan(centreX(byId(laid, 'S1')))
    expect(overlaps(laid, edges)).toEqual([])
  })
})
