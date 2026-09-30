/**
 * The Liberty1 click workflow definition (#1545) passes the canvas's own save
 * checks, so building it from docs/workflows/liberty1-click/definition.json
 * cannot land on a canvas that refuses to save it live: every node configured,
 * all seven buyer_click_send handles wired, no cycle, no output forked to two
 * places. The engine side walks the same file in
 * apps/worker/src/engine/__tests__/liberty1-click-workflow.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { findDuplicateOutEdges, findUnwiredRequiredHandles, findWorkflowCycle, validateWorkflowDef } from '../workflow-validation'
import type { EdgeDef, NodeDef } from '@/types/workflow'
import { REPO_ROOT } from './_scan-utils'

const file = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/workflows/liberty1-click/definition.json'), 'utf8')) as {
  name: string
  definition: { trigger: { type: string; config: Record<string, unknown> }; nodes: NodeDef[]; edges: EdgeDef[] }
}
const { nodes, edges } = file.definition

// The canvas's React Flow shapes, which the fork and cycle checks read.
const flowNodes: Node[] = nodes.map((n) => ({ id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: { namespace: n.namespace, label: n.label, config: n.config } }))
const flowEdges: Edge[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.source_handle }))

describe('the Liberty1 click definition', () => {
  it('is a POST trigger behind an API key, entered once from the trigger', () => {
    expect(file.definition.trigger).toEqual({ type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } })
    expect(edges.filter((e) => e.source === 'trigger')).toHaveLength(1)
  })

  it('names the Liberty1 partner the canvas picked, so the file is the live settings and saves live as it stands (#1662)', () => {
    // Left empty until the partner existed; the hourly drift check now compares this file with the canvas,
    // which holds Liberty1's partner row (slug liberty1, read 2026-09-30).
    const send = nodes.find((n) => n.type === 'buyer_click_send')
    expect(send?.config).toMatchObject({ partner_id: '4ed89cc6-b25b-4537-8b3d-5bf1fc237cc3' })
    expect(validateWorkflowDef(nodes, edges)).toEqual([])
  })

  it('wires every handle buyer_click_send can take', () => {
    expect([...findUnwiredRequiredHandles(nodes, edges).values()]).toEqual([])
  })

  it('has no cycle and no output wired to two different nodes', () => {
    expect(findWorkflowCycle(flowNodes, flowEdges)).toBeNull()
    expect([...findDuplicateOutEdges(flowNodes, flowEdges).values()]).toEqual([])
  })

  it('reaches every node from the trigger, so nothing on it is dead', () => {
    const seen = new Set<string>(['trigger'])
    const queue = ['trigger']
    while (queue.length) {
      const id = queue.shift() as string
      for (const e of edges.filter((x) => x.source === id)) {
        if (!seen.has(e.target)) {
          seen.add(e.target)
          queue.push(e.target)
        }
      }
    }
    expect(nodes.filter((n) => !seen.has(n.id)).map((n) => n.namespace)).toEqual([])
  })

  it('has unique namespaces and node ids', () => {
    expect(new Set(nodes.map((n) => n.namespace)).size).toBe(nodes.length)
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
  })
})
