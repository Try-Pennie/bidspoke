/**
 * Which workflows sell to a partner (#1412): the rename impact route and the
 * buyer profile route both ask, so the answer lives once here (L613). The two
 * differ in one thing the caller states: whether a buyer_select node counts.
 * Rename impact wants every workflow that would be broken by a formula rewrite,
 * buyer_select included; the profile page's `other_sellers` wants the sellers
 * OUTSIDE buyer selection, whose wins the caps do not count (L582, L287).
 */
import { describe, expect, it } from 'vitest'
import { populationsInUse, workflowsUsingPartner, type WorkflowForFinder } from '../partner-workflow-finder'

const wf = (id: string, nodes: Array<Record<string, unknown>>, is_active = true): WorkflowForFinder => ({ id, name: `Workflow ${id}`, is_active, definition: { nodes } })

const mainFlow = wf('main', [{ type: 'bid_group', config: { partner_ids: ['p-tripoint', 'p-liberty'], fallback_partner_id: 'p-engine' } }])
const leadEconomy = wf('le', [{ type: 'partner_bid', config: { partner_id: 'p-tripoint' } }])
const engine = wf('engine', [{ type: 'buyer_select', config: { population: 'engine', mode: 'live' } }])
const draft = wf('draft', [{ type: 'bid_group', config: { partner_ids: ['p-tripoint'] } }], false)
const priced = new Map([['engine', new Set(['p-tripoint'])]])

describe('workflowsUsingPartner', () => {
  it('names bid_group members, the fallback partner and partner_bid nodes', () => {
    const find = workflowsUsingPartner([mainFlow, leadEconomy], priced, { includeBuyerSelect: true })
    expect(find('p-tripoint').map((w) => w.id)).toEqual(['main', 'le'])
    expect(find('p-engine').map((w) => w.id)).toEqual(['main'])
    expect(find('p-nobody')).toEqual([])
  })

  it('counts a buyer_select workflow only through the partners priced for its population, and only when asked', () => {
    const withNode = workflowsUsingPartner([engine], priced, { includeBuyerSelect: true })
    expect(withNode('p-tripoint').map((w) => w.id)).toEqual(['engine'])
    expect(withNode('p-liberty')).toEqual([])
    const without = workflowsUsingPartner([engine], priced, { includeBuyerSelect: false })
    expect(without('p-tripoint')).toEqual([])
  })

  it('a buyer_select population with no priced set is not a match, never an allow (L72)', () => {
    const find = workflowsUsingPartner([engine], new Map(), { includeBuyerSelect: true })
    expect(find('p-tripoint')).toEqual([])
  })

  it('skips nodes with no config and workflows with no definition', () => {
    const odd: WorkflowForFinder[] = [
      { id: 'x', name: 'X', is_active: true, definition: null },
      { id: 'y', name: 'Y', is_active: true, definition: { nodes: [{ type: 'bid_group' }, null as unknown as Record<string, unknown>] } },
    ]
    expect(workflowsUsingPartner(odd, priced, { includeBuyerSelect: true })('p-tripoint')).toEqual([])
  })

  it('an inactive workflow is reported only when the caller asks for drafts too', () => {
    const live = workflowsUsingPartner([mainFlow, draft], priced, { includeBuyerSelect: true, liveOnly: true })
    expect(live('p-tripoint').map((w) => w.id)).toEqual(['main'])
    const all = workflowsUsingPartner([mainFlow, draft], priced, { includeBuyerSelect: true })
    expect(all('p-tripoint').map((w) => w.id)).toEqual(['main', 'draft'])
  })
})

describe('populationsInUse', () => {
  it('collects the populations buyer_select nodes name, once each', () => {
    const second = wf('engine2', [{ type: 'buyer_select', config: { population: 'engine' } }, { type: 'buyer_select', config: { population: 'main_flow' } }])
    expect([...populationsInUse([engine, second, mainFlow])].sort()).toEqual(['engine', 'main_flow'])
  })
  it('ignores a node whose population is not a string', () => {
    expect([...populationsInUse([wf('z', [{ type: 'buyer_select', config: { population: 7 } }])])]).toEqual([])
  })
})
