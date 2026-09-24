/**
 * The #1544 canvas change passes the canvas's own save checks, so applying
 * docs/workflows/engine-bidding/liberty1-wiring.json to the live Engine Bidding
 * Workflow cannot land on a canvas that refuses to save it: the new nodes are
 * configured once the buyer is picked, both buyer_click_check handles are
 * wired, no cycle, no output forked to two places, and build_response_body is
 * still reached on every path into it. Checked against the live tail excerpt
 * the engine walk test uses (read from the mirror, version 100); the engine
 * side is apps/worker/src/engine/__tests__/engine-bidding-liberty1-walk.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { findDuplicateOutEdges, findUnwiredRequiredHandles, findWorkflowCycle, validateWorkflowDef } from '../workflow-validation'
import type { EdgeDef, NodeDef } from '@/types/workflow'
import { REPO_ROOT } from './_scan-utils'

type Wiring = { add_nodes: NodeDef[]; remove_edges: Array<EdgeDef & { was: string }>; add_edges: EdgeDef[] }
const read = <T,>(p: string): T => JSON.parse(readFileSync(path.join(REPO_ROOT, p), 'utf8')) as T
const wiring = read<Wiring>('docs/workflows/engine-bidding/liberty1-wiring.json')
const tail = read<{ nodes: NodeDef[]; edges: EdgeDef[] }>('apps/worker/src/engine/scripts/__tests__/fixtures/engine-bidding-tail-v100.json')

const removed = new Set(wiring.remove_edges.map((e) => e.id))
// The tail's code nodes carry no script (the tests supply the kept ones), so give them one for the save check.
const nodes: NodeDef[] = [...tail.nodes, ...wiring.add_nodes].map((n) => (n.type === 'code' && !n.config.script ? { ...n, config: { ...n.config, script: 'return {}' } } : n))
const edges: EdgeDef[] = [...tail.edges.filter((e) => !removed.has(e.id)), ...wiring.add_edges]
const picked = nodes.map((n) => (n.type === 'buyer_click_check' ? { ...n, config: { ...n.config, partner_id: '0192a4f0-0000-7000-8000-00000000a1b1' } } : n))

const flowNodes: Node[] = nodes.map((n) => ({ id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: { namespace: n.namespace, label: n.label, config: n.config } }))
const flowEdges: Edge[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.source_handle }))
const byNs = (ns: string) => nodes.find((n) => n.namespace === ns)!

describe('the #1544 wiring on the live Engine Bidding tail', () => {
  it('removes only edges the live definition holds, each exactly as the guide describes it', () => {
    for (const e of wiring.remove_edges) expect(tail.edges.find((x) => x.id === e.id), e.was).toMatchObject({ source: e.source, target: e.target, source_handle: e.source_handle })
  })

  it('leaves the buyer empty, so a save is refused until the click buyer is picked on the node', () => {
    expect(byNs('buyer_click_check').config).toMatchObject({ partner_id: '' })
    expect(validateWorkflowDef(nodes, edges).map((e) => e.namespace)).toEqual(['buyer_click_check'])
  })

  it('has every node configured once the buyer is picked', () => {
    expect(validateWorkflowDef(picked, edges)).toEqual([])
  })

  it('wires both buyer_click_check handles and every buyer_select handle', () => {
    expect([...findUnwiredRequiredHandles(nodes, edges).values()]).toEqual([])
  })

  it('has no cycle and no output wired to two different nodes', () => {
    expect(findWorkflowCycle(flowNodes, flowEdges)).toBeNull()
    expect([...findDuplicateOutEdges(flowNodes, flowEdges).values()]).toEqual([])
  })

  it('reaches build_response_body only through the join or a buyer_select sale, and the gate from both ways a known no arrives', () => {
    const into = (ns: string) => edges.filter((e) => e.target === byNs(ns).id).map((e) => `${nodes.find((n) => n.id === e.source)?.namespace}:${e.source_handle}`).sort()
    expect(into('build_response_body')).toEqual(['buyer_select:sold', 'route_known_no_end:output'])
    expect(into('known_no_gate')).toEqual(['buyer_select:no_sale', 'tripoint_ping:output'])
    expect(into('route_known_no_end')).toEqual(['buyer_click_check:eligible', 'buyer_click_check:not_eligible', 'route_known_no:else', 'route_known_no:output'])
  })

  it('has unique namespaces and node ids', () => {
    expect(new Set(nodes.map((n) => n.namespace)).size).toBe(nodes.length)
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
  })
})
