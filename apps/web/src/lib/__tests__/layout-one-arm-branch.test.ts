import { describe, it, expect } from 'vitest'
import { layoutWorkflow } from '../layout'
import { outputHandles } from '../handle-geometry'
import liberty1 from './fixtures/liberty1-click.json'
import { canvasFromDef, centreX, type DefEdge, type DefNode } from './_canvas-from-def'

// #1567: a branch with a single arm (else_behavior "none") put its child far to
// the right instead of under it, and each nested one arm branch walked further
// right, so the Liberty1 click workflow's Salesforce writes drew as a staircase.
// The fixture is that workflow's saved definition (2026-09-25), because its three
// nested one arm branches are the shape that exposed it.
const def = liberty1 as { nodes: DefNode[]; edges: DefEdge[] }
const buildCanvas = () => canvasFromDef(def)

describe('a branch with one arm (#1567)', () => {
  const { nodes, edges } = buildCanvas()
  const laid = layoutWorkflow(nodes, edges)
  const byNs = (ns: string) => laid.find((n) => (n.data as { namespace?: string }).namespace === ns)!
  const oneArm = laid.filter((n) => n.type === 'branch' && outputHandles(n).length === 1)

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
