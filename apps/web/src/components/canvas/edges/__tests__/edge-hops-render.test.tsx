import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { EdgeProps } from '@xyflow/react'
import { LateBendEdge } from '../LateBendEdge'
import { ConvergeEdge } from '../ConvergeEdge'
import { EdgeHopsContext, routesFromState, routesKeySelector } from '../edge-hops'
import { turnY, HOP_RADIUS } from '../edge-routes'

// #1570: both wire types draw the arches the canvas-wide crossing pass gives them,
// and that pass reads each wire's ends from the handles as React Flow places them.

function drawn(Edge: (p: EdgeProps) => JSX.Element, hops: Map<string, number[]>) {
  const props = { id: 'unknown', source: 'a', target: 'b', sourceX: 1380.3, sourceY: 1399, targetX: 1988, targetY: 1464, sourcePosition: 'bottom', targetPosition: 'top' } as unknown as EdgeProps
  const { container } = render(
    <EdgeHopsContext.Provider value={hops}>
      <svg><Edge {...props} /></svg>
    </EdgeHopsContext.Provider>,
  )
  return container.querySelector('path.react-flow__edge-path')!.getAttribute('d')!
}

describe.each([
  ['LateBendEdge', LateBendEdge],
  ['ConvergeEdge', ConvergeEdge],
])('%s', (_name, Edge) => {
  it('turns on the shared line above its target', () => {
    expect(drawn(Edge, new Map())).toContain(` ${turnY({ sourceY: 1399, targetY: 1464 })} `)
  })

  it('arches over the drop the crossing pass found for it', () => {
    expect(drawn(Edge, new Map([['unknown', [1684]]]))).toContain(`A${HOP_RADIUS} ${HOP_RADIUS}`)
  })

  it('draws no arch when it crosses nothing', () => {
    expect(drawn(Edge, new Map([['someone_else', [1684]]]))).not.toContain('A')
  })
})

describe('routesFromState', () => {
  // Two nodes as React Flow stores them: the source handle sits on the card's
  // bottom edge and the target handle on the card's top edge.
  const node = (x: number, y: number, source: object[], target: object[]) => ({ internals: { positionAbsolute: { x, y }, handleBounds: { source, target } } })
  const state = (edges: object[]) => ({
    edges,
    nodeLookup: new Map<string, unknown>([
      ['a', node(1000, 1000, [{ id: 'sent', x: 100, y: 393, width: 6, height: 6 }], [])],
      ['b', node(1300, 1464, [], [{ id: null, x: 101, y: -3, width: 6, height: 6 }])],
      ['up', node(1300, 500, [], [{ id: null, x: 101, y: -3, width: 6, height: 6 }])],
    ]),
  })

  it('reads each end from the handle the way React Flow places it: bottom centre out, top centre in', () => {
    const [r] = routesFromState(state([{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'sent', targetHandle: null }]) as never)
    expect(r).toEqual({ id: 'e1', sx: 1103, sy: 1399, tx: 1404, ty: 1461 })
  })

  it('leaves out a wire whose handle is not measured to real numbers, rather than placing it at 0', () => {
    const s = state([{ id: 'nan', source: 'a', target: 'b', sourceHandle: 'sent', targetHandle: null }])
    ;(s.nodeLookup.get('a') as { internals: { handleBounds: { source: Array<{ width: number }> } } }).internals.handleBounds.source[0].width = Number.NaN
    expect(routesFromState(s as never)).toEqual([])
  })

  it('leaves out hidden wires and wires that climb back up, which are not drawn down, across and down', () => {
    const routes = routesFromState(state([
      { id: 'hidden', source: 'a', target: 'b', sourceHandle: 'sent', targetHandle: null, hidden: true },
      { id: 'climbs', source: 'a', target: 'up', sourceHandle: 'sent', targetHandle: null },
    ]) as never)
    expect(routes).toEqual([])
  })
})

describe('routesKeySelector', () => {
  // The store notifies on every pan and zoom. Those move only the view, so the
  // whole canvas walk is skipped for them; anything else, including React Flow's
  // empty update after measuring handles, walks again.
  function counted() {
    let walks = 0
    const nodeLookup = new Map<string, unknown>()
    const edges: object[] = []
    const lookup = { get(id: string) { walks++; return nodeLookup.get(id) } }
    return { edges: [{ id: 'e', source: 'a', target: 'b' }], lookup, walks: () => walks, edgesArr: edges }
  }

  it('does not walk the canvas again when only the view moved', () => {
    const c = counted()
    const select = routesKeySelector()
    const s1 = { edges: c.edges, nodes: [], nodeLookup: c.lookup, transform: [0, 0, 1] }
    select(s1 as never)
    const before = c.walks()
    select({ ...s1, transform: [40, 10, 1] } as never)
    select({ ...s1, transform: [80, 20, 1.2] } as never)
    expect(c.walks()).toBe(before)
  })

  it('walks again on an update that leaves the view alone, as after handles are measured', () => {
    const c = counted()
    const select = routesKeySelector()
    const s1 = { edges: c.edges, nodes: [], nodeLookup: c.lookup, transform: [0, 0, 1] }
    select(s1 as never)
    const before = c.walks()
    select({ ...s1 } as never)
    expect(c.walks()).toBeGreaterThan(before)
  })
})
