import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Node, Edge, NodeProps } from '@xyflow/react'
import type { ComponentType } from 'react'
import { NODE_TYPES, type NodeType } from '@/types/workflow'
import { layoutWorkflow, nodeWidth, NODE_W } from '@/lib/layout'
import { CARD_KIND, SLOT_GAP, handleLeftFractions, outputHandles } from '@/lib/handle-geometry'
import { baseNodeTypes } from '../registry'
import { FilterNode } from '../FilterNode'

// Guards for the wiring ruleset (#1578, milestone 55). The card draws its
// handles from the geometry the layout published, and the layout places each
// child from that same geometry, so a card and the layout can no longer each
// keep their own copy of where a handle is.

const updateNodeInternals = vi.fn()
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useUpdateNodeInternals: () => updateNodeInternals,
}))
beforeEach(() => updateNodeInternals.mockClear())

// One representative config per node type. A type added to the node type list
// without one is a compile error, so no card escapes these guards.
const CONFIG: Record<NodeType, Record<string, unknown>> = {
  filter: { operation: 'continue_if' },
  branch: { branches: [{ label: 'hot' }, { label: 'cold' }], else_behavior: 'output' },
  branch_end: {},
  code: { script: 'return {}' },
  response: {},
  exit: {},
  parallel: { children: [{ id: 'fast', label: 'fast' }, { id: 'slow', label: 'slow' }] },
  parallel_end: {},
  partner_bid: {},
  bid_group: { mode: 'highest_bid' },
  webhook: {},
  transform: {},
  constants: {},
  salesforce: {},
  data_store: {},
  latency_gate: { operation: 'check' },
  achieve_offers: {},
  buyer_select: { mode: 'live', population: 'engine' },
  buyer_click_send: { partner_id: 'p' },
  buyer_click_check: { partner_id: 'p' },
}

/** trigger -> N, with every output of N wired to a child of its own. */
function laidOut(type: NodeType): { node: Node; laid: Node[] } {
  const n: Node = { id: 'N', type, position: { x: 0, y: 0 }, data: { namespace: 'n', label: '', config: CONFIG[type], isReachable: true } }
  const handles = outputHandles(n)
  const nodes: Node[] = [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }, n]
  const edges: Edge[] = [{ id: 't', source: 'trigger', target: 'N' }]
  handles.forEach((h, i) => {
    nodes.push({ id: `C${i}`, type: 'code', position: { x: 0, y: 0 }, data: { namespace: `c${i}`, config: {} } })
    edges.push({ id: `e${i}`, source: 'N', target: `C${i}`, sourceHandle: h })
  })
  const laid = layoutWorkflow(nodes, edges)
  return { node: laid.find((x) => x.id === 'N')!, laid }
}

function drawnSourceHandles(type: string, node: Node) {
  const Card = baseNodeTypes[type] as ComponentType<NodeProps>
  const { container, unmount } = render(<ReactFlowProvider><Card {...({ id: node.id, data: node.data, selected: false } as unknown as NodeProps)} /></ReactFlowProvider>)
  const handles = [...container.querySelectorAll<HTMLElement>('.react-flow__handle.source')].map((el) => ({
    id: el.getAttribute('data-handleid'),
    left: el.style.left,
  }))
  unmount()
  return handles
}

const centre = (n: Node) => n.position.x + nodeWidth(n.type, n.data) / 2

describe.each(NODE_TYPES)('the %s card', (type) => {
  it('draws exactly the handles the geometry lists, where the layout published them', () => {
    const { node } = laidOut(type)
    const handles = outputHandles(node)
    const drawn = drawnSourceHandles(type, node)
    if (handles.length === 0) {
      // A single output card draws at most its one pass through handle.
      expect(drawn.every((h) => h.id === 'output' && h.left === '')).toBe(true)
      return
    }
    expect(drawn.map((h) => h.id)).toEqual(handles)
    const offsets = (node.data as { _handleOffsets?: number[] })._handleOffsets
    expect(offsets, 'the layout publishes a position for every handle').toHaveLength(handles.length)
    const fractions = handleLeftFractions(type, handles, offsets, nodeWidth(type, node.data))
    drawn.forEach((h, i) => expect(parseFloat(h.left)).toBeCloseTo(fractions[i] * 100, 3))
  })

  it('puts each child in its column', () => {
    const { node, laid } = laidOut(type)
    const handles = outputHandles(node)
    const kids = handles.map((_, i) => laid.find((x) => x.id === `C${i}`)!)
    if (CARD_KIND[type] === 'fanout' || handles.length === 1) {
      const offsets = (node.data as { _handleOffsets: number[] })._handleOffsets
      kids.forEach((k, i) => expect(centre(k) - centre(node)).toBeCloseTo(offsets[i], 0))
    } else if (CARD_KIND[type] === 'fixed') {
      // Both outputs wired: the children spread into columns and the wires bend.
      const step = NODE_W + SLOT_GAP
      kids.forEach((k, i) => expect(centre(k) - centre(node)).toBeCloseTo((i - (kids.length - 1) / 2) * step, 0))
    }
  })
})

describe('a wiring change re-anchors the drawn handles (#1578 guard 5)', () => {
  // WorkflowCanvas is not mountable in jsdom yet (#737), so this proves the two
  // halves: each wiring handler re-runs the layout on the new edges, and the
  // card redraws its handles from what that layout publishes and tells React
  // Flow its handles moved, so the wires follow.
  it('connect, reconnect and edge removal each re-run the layout on the new edges', () => {
    const src = readFileSync(path.join(__dirname, '..', '..', 'WorkflowCanvas.tsx'), 'utf8')
    const body = (name: string) => src.slice(src.indexOf(`const ${name}`), src.indexOf('[snapshot', src.indexOf(`const ${name}`)))
    expect(body('onConnect: OnConnect')).toMatch(/layoutWorkflow\(shifted, next\)/)
    expect(body('onReconnect')).toMatch(/layoutWorkflow\(shifted, next\)/)
    const removal = src.slice(src.indexOf('onEdgesChange={(changes)'), src.indexOf('onConnect={onConnect}'))
    expect(removal).toMatch(/layoutWorkflow\(ns, remaining\)/)
  })

  it('moves a filter\'s pass handle off the centre when exit is connected, and back when it is removed', () => {
    const base: Node[] = [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'F', type: 'filter', position: { x: 0, y: 0 }, data: { namespace: 'f', config: { operation: 'continue_if' }, isReachable: true } },
      { id: 'A', type: 'code', position: { x: 0, y: 0 }, data: { namespace: 'a', config: {} } },
      { id: 'B', type: 'code', position: { x: 0, y: 0 }, data: { namespace: 'b', config: {} } },
    ]
    const passOnly: Edge[] = [{ id: 't', source: 'trigger', target: 'F' }, { id: 'p', source: 'F', target: 'A', sourceHandle: 'pass' }]
    const both: Edge[] = [...passOnly, { id: 'x', source: 'F', target: 'B', sourceHandle: 'exit' }]
    const dataFor = (edges: Edge[]) => layoutWorkflow(base, edges).find((n) => n.id === 'F')!.data
    const props = (edges: Edge[]) => ({ id: 'F', data: dataFor(edges), selected: false }) as unknown as NodeProps
    const passLeft = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-handleid="pass"]')!.style.left

    const { container, rerender } = render(<ReactFlowProvider><FilterNode {...props(passOnly)} /></ReactFlowProvider>)
    expect(passLeft(container)).toBe('50%')
    updateNodeInternals.mockClear()
    rerender(<ReactFlowProvider><FilterNode {...props(both)} /></ReactFlowProvider>)
    expect(parseFloat(passLeft(container))).toBeCloseTo(30, 3)
    expect(updateNodeInternals).toHaveBeenCalledWith('F')
    updateNodeInternals.mockClear()
    rerender(<ReactFlowProvider><FilterNode {...props(passOnly)} /></ReactFlowProvider>)
    expect(passLeft(container)).toBe('50%')
    expect(updateNodeInternals).toHaveBeenCalledWith('F')
  })
})

describe('every multi output card draws its outputs through SourceHandles (#1578 guard 4)', () => {
  it('has no source handle outside SourceHandles but a single card\'s plain output', () => {
    const dir = path.join(__dirname, '..')
    const offenders: string[] = []
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx') && x !== 'SourceHandles.tsx')) {
      const src = readFileSync(path.join(dir, f), 'utf8')
      for (const tag of src.match(/<Handle\b[\s\S]*?\/>/g) ?? []) {
        if (!/type="source"/.test(tag)) continue
        const plainOutput = /id="output"/.test(tag) && !/style=|left|\$\{/.test(tag)
        if (!plainOutput) offenders.push(`${f}: ${tag.replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
