import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { layoutWorkflow } from '../layout'
import { outputHandles } from '../handle-geometry'
import { canvasFromDef, canvasWidth, centreX, overlaps, type DefEdge, type DefNode } from './_canvas-from-def'
import { REPO_ROOT } from './_scan-utils'
import liberty1v5 from './fixtures/liberty1-click-v5.json'
import mainFlow from './fixtures/main-flow.json'
import engine from './fixtures/engine-bidding.json'

// The three canvases the wiring ruleset (#1576, milestone 55) was planned
// against, laid out whole. A toy graph passes whichever rule is in force; these
// are the shapes that drew staircases (Liberty1, #1567 and v5's filters) and the
// one a careless placement rule would drag a shared bid_group across (Main Flow).
//
// Drawn widths, measured 2026-09-25 on branch 1576-wiring-ruleset against main
// at 0f4184b3, the same before and after this change, with no overlaps on either:
//   Liberty1 click v5   3,248 px
//   Main Flow           4,464 px (the width #1499 recorded)
//   Engine plus #1544   2,184 px (1,120 px without the wiring)
// They are recorded, not asserted: a width is a consequence of the rule, and a
// fixed number here would defend whatever the layout happened to produce.

type Def = { nodes: DefNode[]; edges: DefEdge[] }
type Wiring = { add_nodes: DefNode[]; remove_edges: Array<{ id: string }>; add_edges: DefEdge[] }

// Engine Bidding with the #1544 Liberty1 wiring applied: synthetic until #1544
// ships, so this canvas is the one the wiring WILL produce, not one that exists.
function engineWithLiberty1(): Def {
  const wiring = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/workflows/engine-bidding/liberty1-wiring.json'), 'utf8')) as Wiring
  const base = engine as unknown as Def
  const removed = new Set(wiring.remove_edges.map((e) => e.id))
  return { nodes: [...base.nodes, ...wiring.add_nodes], edges: [...base.edges.filter((e) => !removed.has(e.id)), ...wiring.add_edges] }
}

const CANVASES: Array<[string, () => Def]> = [
  ['Liberty1 click v5', () => liberty1v5 as unknown as Def],
  ['Main Flow', () => mainFlow as unknown as Def],
  ['Engine Bidding plus the #1544 wiring (synthetic)', engineWithLiberty1],
]

describe.each(CANVASES)('%s', (_name, def) => {
  const { nodes, edges } = canvasFromDef(def())
  const laid = layoutWorkflow(nodes, edges)

  it('lays out with no two cards overlapping', () => {
    expect(overlaps(laid, edges)).toEqual([])
  })

  it('has a drawn width (recorded above)', () => {
    expect(canvasWidth(laid, edges)).toBeGreaterThan(0)
  })
})

describe('Liberty1 click v5', () => {
  const { nodes, edges } = canvasFromDef(liberty1v5 as unknown as Def)
  const laid = layoutWorkflow(nodes, edges)
  const byNs = (ns: string) => laid.find((n) => (n.data as { namespace?: string }).namespace === ns)!

  it('holds the three filters whose only wired output is pass (#1574)', () => {
    const passOnly = laid.filter((n) => {
      if (n.type !== 'filter') return false
      const wired = new Set(edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle))
      return wired.size === 1 && wired.has('pass')
    })
    expect(passOnly.map((n) => (n.data as { namespace: string }).namespace).sort()).toEqual(['check_lead', 'check_submission', 'check_write'])
  })

  it.each([
    ['check_write', 'update_prospect'],
    ['check_submission', 'update_submission'],
    ['check_lead', 'update_lead'],
  ])('%s draws pass at its centre and puts %s straight below it', (filter, child) => {
    const f = byNs(filter)
    expect(outputHandles(f)).toEqual(['pass', 'exit'])
    expect((f.data as { _handleOffsets?: number[] })._handleOffsets?.[0]).toBe(0)
    expect(Math.abs(centreX(byNs(child)) - centreX(f))).toBeLessThan(1)
  })
})
