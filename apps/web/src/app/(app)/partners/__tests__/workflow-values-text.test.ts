/**
 * The Workflow values tab's words and rows (#2142, PM-15), from the workflow
 * values answer: which sections a partner shows and in what order, how each
 * value is read, and who reads it.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { PartnerValueKind, PartnerWorkflowValue, PartnerWorkflowValues } from '@/lib/api'
import {
  PARTNER_VALUE_KINDS, accessLines, editsSection, readerSentences, refreshKeyOf, searchedSentence, sectionsOf, shadowSentences, type SectionKey, type ValueSection,
} from '../workflow-values-text'

const value = (kind: PartnerValueKind, over: Partial<PartnerWorkflowValue> = {}): PartnerWorkflowValue => {
  const map = kind === 'subAccountIdsMap' || kind === 'activeBidding'
  const name = map ? kind : `Acme${kind}`
  return {
    constant_name: name, kind, map,
    access: { template: `steps.constants.output.${name}`, code: `constants.${name}` },
    emitted: false, value: null, readers: [], shadowed_data_keys: [], readers_outside_workflows: [],
    ...over,
  }
}
const answer = (values: PartnerWorkflowValue[]): PartnerWorkflowValues => ({
  partner: { id: 'p1', slug: 'acme' }, values, searched: { workflows: 11, with_constants_node: 7 },
})
const all = () => PARTNER_VALUE_KINDS.map((k) => value(k))
const keys = (s: ValueSection[]) => s.map((x) => x.key)
const reader = (over: Partial<PartnerWorkflowValue['readers'][number]> = {}) => ({
  workflow_id: 'w1', workflow_name: 'Engine Bidding Workflow', is_active: true, reads: 'by_name' as const,
  places: [{ node_id: 'n1', namespace: 'build_response_body', label: 'Build Response Body', node_type: 'code', edge_id: null, reads: 'by_name' as const }],
  ...over,
})

describe('the kinds the tab knows', () => {
  it('are exactly the kinds the answer can carry', () => {
    expectTypeOf<(typeof PARTNER_VALUE_KINDS)[number]>().toEqualTypeOf<PartnerValueKind>()
  })

  it('each have a section, so every value the Constants step emits has a row', () => {
    const s = sectionsOf(answer(all().map((v) => ({ ...v, emitted: true }))), { isBuyer: true, isSource: true })
    const named = s.flatMap((x) => x.values.map((v) => v.kind))
    expect(named.sort()).toEqual([...PARTNER_VALUE_KINDS].sort())
    expect(s.every((x) => x.key !== 'other')).toBe(true)
  })

  it('a kind the page does not know yet is still shown, under its own name, never dropped', () => {
    const scratch = { ...value('ClickUrl'), kind: 'Scratch' as PartnerValueKind, constant_name: 'AcmeScratch', emitted: true }
    const s = sectionsOf(answer([scratch]), { isBuyer: false, isSource: false })
    expect(s).toEqual([{ key: 'other', title: 'AcmeScratch', values: [scratch] }])
  })
})

describe('which sections a partner shows, in the answer order', () => {
  it('a buyer: its click URL and minimum bids, and Active, which every partner carries', () => {
    const v = all()
    v[5] = { ...v[5], emitted: true, value: true }
    expect(keys(sectionsOf(answer(v), { isBuyer: true, isSource: false }))).toEqual(['click_url', 'min_bids', 'active'])
  })

  it('a source: its sell-off offer, as one section for the title and details, and its sub-account IDs', () => {
    const s = sectionsOf(answer(all()), { isBuyer: false, isSource: true })
    expect(keys(s)).toEqual(['sell_off', 'sub_account_ids'])
    expect(s[0].values.map((x) => x.kind)).toEqual(['SellOffOfferTitle', 'SellOffOfferDetails'])
  })

  it('a value outside the partner type shows when it is emitted, named by a workflow, or replaces a workflow data key', () => {
    const v = all()
    v[0] = { ...v[0], emitted: true }
    v[3] = { ...v[3], readers: [reader()] }
    v[4] = { ...v[4], shadowed_data_keys: [{ workflow_id: 'w', workflow_name: 'Main Flow', is_active: true, node_id: 'c', namespace: 'constants' }] }
    expect(keys(sectionsOf(answer(v), { isBuyer: false, isSource: false }))).toEqual(['click_url', 'min_bids', 'sub_account_ids'])
  })

  it('a value read only for every partner, with nothing set, stays off a partner it does not apply to', () => {
    const v = all()
    v[4] = { ...v[4], readers: [reader({ reads: 'every_partner' })] }
    expect(keys(sectionsOf(answer(v), { isBuyer: true, isSource: false }))).toEqual(['click_url', 'min_bids'])
  })

  it('an answer that leaves out a value the partner edits still shows its control', () => {
    expect(keys(sectionsOf(answer([]), { isBuyer: false, isSource: true }))).toEqual(['sell_off', 'sub_account_ids'])
  })

  it('with no answer yet (new, still reading or failed) the partner type alone decides', () => {
    expect(keys(sectionsOf(null, { isBuyer: true, isSource: true }))).toEqual(['click_url', 'sell_off', 'min_bids', 'sub_account_ids'])
  })
})

describe('when the tab reads again', () => {
  it('the key moves with the version and with the sub-account IDs themselves, so a swapped ID re-reads too', () => {
    const a = refreshKeyOf(3, [{ id: 'u1' }, { id: 'u2' }])
    expect(refreshKeyOf(3, [{ id: 'u1' }, { id: 'u3' }])).not.toBe(a)
    expect(refreshKeyOf(4, [{ id: 'u1' }, { id: 'u2' }])).not.toBe(a)
    expect(refreshKeyOf(3, [{ id: 'u2' }, { id: 'u1' }])).toBe(a)
  })
})

describe('which sections the partner edits here', () => {
  it('a buyer edits the click URL and minimum bids, a source the sell-off offer and IDs, nobody Active', () => {
    const buyer = { isBuyer: true, isSource: false }
    const source = { isBuyer: false, isSource: true }
    expect(['click_url', 'sell_off', 'min_bids', 'sub_account_ids', 'active', 'other'].filter((k) => editsSection(k as SectionKey, buyer))).toEqual(['click_url', 'min_bids'])
    expect(['click_url', 'sell_off', 'min_bids', 'sub_account_ids', 'active', 'other'].filter((k) => editsSection(k as SectionKey, source))).toEqual(['sell_off', 'sub_account_ids'])
  })
})

describe('how a value is read', () => {
  it('a flat value: the Code node form and the template form', () => {
    expect(accessLines([value('ClickUrl')], 'acme')).toEqual([
      { lead: 'Workflows read it as', code: 'constants.AcmeClickUrl', template: 'steps.constants.output.AcmeClickUrl', tail: '' },
    ])
  })

  it('the sell-off offer: the title and the details each by their own name', () => {
    expect(accessLines([value('SellOffOfferTitle'), value('SellOffOfferDetails')], 'acme').map((l) => [l.lead, l.code])).toEqual([
      ['Workflows read the title as', 'constants.AcmeSellOffOfferTitle'],
      ['Workflows read the details as', 'constants.AcmeSellOffOfferDetails'],
    ])
  })

  it('Active: this partner\'s entry in activeBidding', () => {
    expect(accessLines([value('activeBidding')], 'acme')).toEqual([
      { lead: 'Workflows read it as', code: 'constants.activeBidding.acme', template: 'steps.constants.output.activeBidding.acme', tail: '' },
    ])
  })

  it('an entry whose slug is not a name is written with brackets', () => {
    expect(accessLines([value('activeBidding')], 'lead-economy')[0].code).toBe("constants.activeBidding['lead-economy']")
  })

  it('sub-account IDs: the map, each ID naming the partner', () => {
    expect(accessLines([value('subAccountIdsMap')], 'acme')).toEqual([
      { lead: 'Workflows read them in', code: 'constants.subAccountIdsMap', template: 'steps.constants.output.subAccountIdsMap', tail: ', where each of these IDs maps to acme.' },
    ])
  })
})

describe('who reads it', () => {
  it('names the workflow and the steps that read the value by name', () => {
    const r = reader({ places: [...reader().places, { node_id: 'n2', namespace: 'tripoint_ping', label: 'Tripoint Ping', node_type: 'code', edge_id: null, reads: 'by_name' }] })
    expect(readerSentences(value('ClickUrl', { readers: [r] }))).toEqual(['Engine Bidding Workflow, in Build Response Body and Tripoint Ping.'])
  })

  it('says a workflow reads this value for every partner when it reads the whole map', () => {
    const r = reader({ reads: 'every_partner', places: [{ node_id: 'n', namespace: 'validate_bidding_and_state', label: 'Validate', node_type: 'code', edge_id: null, reads: 'every_partner' }] })
    expect(readerSentences(value('activeBidding', { readers: [r] }))).toEqual(['Engine Bidding Workflow reads this value for every partner, in Validate.'])
  })

  it('both at once, a switched off workflow, a step with no label and an edge condition', () => {
    const r = reader({
      workflow_name: 'Main Flow (v2)', is_active: false,
      places: [
        { node_id: 'a', namespace: 'pick', label: null, node_type: 'code', edge_id: null, reads: 'by_name' },
        { node_id: null, namespace: null, label: null, node_type: null, edge_id: 'e1', reads: 'every_partner' },
      ],
    })
    expect(readerSentences(value('activeBidding', { readers: [r] }))).toEqual(['Main Flow (v2) (switched off), in pick; it reads this value for every partner in an edge condition.'])
  })

  it('the click URL\'s readers outside workflows come after the workflows, in the answer\'s own words', () => {
    const v = value('ClickUrl', { readers: [reader()], readers_outside_workflows: [{ reader: 'buyer_select', description: 'Buyer selection sends a lead it sells to this partner to the click URL.' }] })
    expect(readerSentences(v)).toEqual(['Engine Bidding Workflow, in Build Response Body.', 'Buyer selection sends a lead it sells to this partner to the click URL.'])
  })

  it('nothing reads it: said as what was searched', () => {
    expect(searchedSentence({ workflows: 11, with_constants_node: 7 })).toBe('No workflow names this value. Searched 11 workflows, 7 of them with a Constants step.')
    expect(searchedSentence({ workflows: 1, with_constants_node: 0 })).toBe('No workflow names this value. Searched 1 workflow, none of them with a Constants step.')
  })

  it('a workflow data key the partner value replaces', () => {
    const v = value('ClickUrl', { shadowed_data_keys: [{ workflow_id: 'w', workflow_name: 'Main Flow', is_active: true, node_id: 'c', namespace: 'constants' }] })
    expect(shadowSentences(v)).toEqual(['Main Flow also sets AcmeClickUrl in its Constants step (constants), and this value replaces it there.'])
  })
})
