/**
 * Which workflows sell to a partner (#1412): the rename impact route and the
 * buyer profile route both ask, so the answer lives once here (L613). The two
 * differ in one thing the caller states: whether a buyer_select node counts.
 * Rename impact wants every workflow that would be broken by a formula rewrite,
 * buyer_select included; the profile page's `other_sellers` wants the sellers
 * OUTSIDE buyer selection, whose wins the caps do not count (L582, L287).
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES } from '@bidspoke/node-types'
import { populationsInUse, workflowsUsingPartner, type WorkflowForFinder } from '../partner-workflow-finder'

const wf = (id: string, nodes: Array<Record<string, unknown>>, is_active = true): WorkflowForFinder => ({ id, name: `Workflow ${id}`, is_active, definition: { nodes } })

const mainFlow = wf('main', [{ type: 'bid_group', config: { partner_ids: ['p-tripoint', 'p-liberty'], fallback_partner_id: 'p-engine' } }])
const leadEconomy = wf('le', [{ type: 'partner_bid', config: { partner_id: 'p-tripoint' } }])
const engine = wf('engine', [{ type: 'buyer_select', config: { population: 'engine', mode: 'live' } }])
const draft = wf('draft', [{ type: 'bid_group', config: { partner_ids: ['p-tripoint'] } }], false)
const priced = new Map([['engine', new Set(['p-tripoint'])]])

describe('workflowsUsingPartner', () => {
  it('names bid_group members, the fallback partner and partner_bid nodes', () => {
    const find = workflowsUsingPartner([mainFlow, leadEconomy], priced, { includeBuyerSelect: true, includeClickNodes: true })
    expect(find('p-tripoint').map((w) => w.id)).toEqual(['main', 'le'])
    expect(find('p-engine').map((w) => w.id)).toEqual(['main'])
    expect(find('p-nobody')).toEqual([])
  })

  it('counts a buyer_select workflow only through the partners priced for its population, and only when asked', () => {
    const withNode = workflowsUsingPartner([engine], priced, { includeBuyerSelect: true, includeClickNodes: true })
    expect(withNode('p-tripoint').map((w) => w.id)).toEqual(['engine'])
    expect(withNode('p-liberty')).toEqual([])
    const without = workflowsUsingPartner([engine], priced, { includeBuyerSelect: false, includeClickNodes: true })
    expect(without('p-tripoint')).toEqual([])
  })

  it('a buyer_select population with no priced set is not a match, never an allow (L72)', () => {
    const find = workflowsUsingPartner([engine], new Map(), { includeBuyerSelect: true, includeClickNodes: true })
    expect(find('p-tripoint')).toEqual([])
  })

  it('skips nodes with no config and workflows with no definition', () => {
    const odd: WorkflowForFinder[] = [
      { id: 'x', name: 'X', is_active: true, definition: null },
      { id: 'y', name: 'Y', is_active: true, definition: { nodes: [{ type: 'bid_group' }, null as unknown as Record<string, unknown>] } },
    ]
    expect(workflowsUsingPartner(odd, priced, { includeBuyerSelect: true, includeClickNodes: true })('p-tripoint')).toEqual([])
  })

  it('an inactive workflow is reported only when the caller asks for drafts too', () => {
    const live = workflowsUsingPartner([mainFlow, draft], priced, { includeBuyerSelect: true, includeClickNodes: true, liveOnly: true })
    expect(live('p-tripoint').map((w) => w.id)).toEqual(['main'])
    const all = workflowsUsingPartner([mainFlow, draft], priced, { includeBuyerSelect: true, includeClickNodes: true })
    expect(all('p-tripoint').map((w) => w.id)).toEqual(['main', 'draft'])
  })
})

describe('buyer_click_send names its partner by id (#1553)', () => {
  const clickFlow = wf('click', [{ type: 'buyer_click_send', config: { partner_id: 'p-liberty', prospect_id: '{{trigger.payload.prospect}}' } }])

  it('is found by its partner id, with or without buyer_select counted', () => {
    for (const includeBuyerSelect of [true, false]) {
      const find = workflowsUsingPartner([clickFlow, leadEconomy], priced, { includeBuyerSelect, includeClickNodes: true })
      expect(find('p-liberty').map((w) => w.id)).toEqual(['click'])
      expect(find('p-tripoint').map((w) => w.id)).toEqual(['le'])
    }
  })

  it('is left out when the caller asks for the sellers outside the click buyer\'s own cap (#1543)', () => {
    // The profile page's other_sellers: a click buyer's clicks ARE its cap, so its
    // own click workflow is not a seller whose wins the cap leaves out.
    const find = workflowsUsingPartner([clickFlow, leadEconomy], priced, { includeBuyerSelect: false, includeClickNodes: false })
    expect(find('p-liberty')).toEqual([])
    expect(find('p-tripoint').map((w) => w.id)).toEqual(['le'])
  })

  it('a node still carrying a slug is not taken for the partner of that name', () => {
    const legacy = wf('legacy', [{ type: 'buyer_click_send', config: { partner_slug: 'p-liberty' } }])
    expect(workflowsUsingPartner([legacy], priced, { includeBuyerSelect: true, includeClickNodes: true })('p-liberty')).toEqual([])
  })
})

/**
 * Every node type whose trait says it references partners by id has a config
 * the finder matches. A new such type without a finder case fails here rather
 * than being silently invisible to the rename and profile routes (L96, L247).
 */
describe('the finder covers every node type that references partners', () => {
  const sample: Record<string, Record<string, unknown>> = {
    partner_bid: { partner_id: 'p-x' },
    bid_group: { partner_ids: ['p-x'] },
    buyer_click_send: { partner_id: 'p-x' },
    buyer_click_check: { partner_id: 'p-x', population: 'engine' },
  }
  const referencing = NODE_TYPES.filter((t) => NODE_TRAITS[t].referencesPartners)

  it('the sample list is exactly the referencing types', () => {
    expect(Object.keys(sample).sort()).toEqual([...referencing].sort())
  })

  for (const type of referencing) {
    it(`finds a ${type} node by its partner id`, () => {
      const find = workflowsUsingPartner([wf(type, [{ type, config: sample[type] }])], new Map(), { includeBuyerSelect: false, includeClickNodes: true })
      expect(find('p-x').map((w) => w.id)).toEqual([type])
      expect(find('p-y')).toEqual([])
    })
  }
})

describe('buyer_click_check names its partner by id (#1543)', () => {
  const offerFlow = wf('engine-offer', [{ type: 'buyer_click_check', config: { partner_id: 'p-liberty', population: 'engine' } }])

  it('is found for the rename impact route, and left out of other_sellers: it offers, it never sells', () => {
    expect(workflowsUsingPartner([offerFlow], priced, { includeBuyerSelect: true, includeClickNodes: true })('p-liberty').map((w) => w.id)).toEqual(['engine-offer'])
    expect(workflowsUsingPartner([offerFlow], priced, { includeBuyerSelect: false, includeClickNodes: false })('p-liberty')).toEqual([])
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
