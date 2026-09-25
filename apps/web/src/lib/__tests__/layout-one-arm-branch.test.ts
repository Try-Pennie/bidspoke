import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { layoutWorkflow, nodeWidth, configuredHandleIds } from '../layout'
import liberty1 from './fixtures/liberty1-click.json'

// #1567: a branch with a single arm (else_behavior "none") put its child far to
// the right instead of under it, and each nested one arm branch walked further
// right, so the Liberty1 click workflow's Salesforce writes drew as a staircase.
// The fixture is that workflow's saved definition (2026-09-25), because its three
// nested one arm branches are the shape that exposed it.
interface DefNode { id: string; type: string; namespace: string; position: { x: number; y: number }; config: Record<string, unknown> | null }
interface DefEdge { id: string; source: string; target: string; source_handle: string | null }
const def = liberty1 as { nodes: DefNode[]; edges: DefEdge[] }

// Mirrors WorkflowCanvas.defToNodes, as layout-branch-end-column.test.ts does.
function buildCanvas(): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const pairByEnd = new Map<string, string>()
  for (const n of def.nodes) {
    if (n.type !== 'branch_end') continue
    const start = def.edges.filter((e) => e.target === n.id).map((e) => byId.get(e.source)).find((x) => x?.type === 'branch')
    if (start) pairByEnd.set(n.id, start.id)
  }
  const nodes: Node[] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    ...def.nodes.map((n) => ({
      id: n.id, type: n.type, position: n.position,
      data: { namespace: n.namespace, config: n.config ?? {}, variables: {}, ...(pairByEnd.has(n.id) ? { _pairId: pairByEnd.get(n.id) } : {}) },
    })),
  ]
  const edges: Edge[] = def.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.source_handle ?? undefined }))
  return { nodes, edges }
}

const centreX = (n: Node) => n.position.x + nodeWidth(n.type, n.data) / 2

describe('a branch with one arm (#1567)', () => {
  const { nodes, edges } = buildCanvas()
  const laid = layoutWorkflow(nodes, edges)
  const byNs = (ns: string) => laid.find((n) => (n.data as { namespace?: string }).namespace === ns)!
  const oneArm = laid.filter((n) => n.type === 'branch' && configuredHandleIds(n)?.length === 1)

  it('the fixture holds the three nested one arm branches that exposed it', () => {
    expect(oneArm.map((n) => (n.data as { namespace: string }).namespace).sort()).toEqual(['check_lead', 'check_submission', 'check_write'])
  })

  it.each([
    ['check_write', 'update_prospect'],
    ['check_submission', 'update_submission'],
    ['check_lead', 'update_lead'],
  ])('%s puts its child %s directly under it', (branch, child) => {
    expect(Math.abs(centreX(byNs(child)) - centreX(byNs(branch)))).toBeLessThan(1)
  })
})
