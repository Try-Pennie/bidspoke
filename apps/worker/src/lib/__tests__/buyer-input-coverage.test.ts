/**
 * #2149: which live buyer steps cannot read a buyer profile's rules. The pure
 * finder both save checks call (a profile save, a live workflow save), so the
 * two sides judge one way.
 */
import { describe, expect, it } from 'vitest'
import type { BuyerProfile } from '@bidspoke/buyer-profile'
import { findInputGaps, inputGapsForProfileSave, inputGapsForWorkflowSave, type CoverageBuyer } from '../buyer-input-coverage'

const tripointProfile: BuyerProfile = {
  partnerId: 'p-tripoint',
  soldOn: 'offer',
  isEnabled: true,
  priority: 1,
  allowedStates: ['TX'],
  debtMin: null,
  debtMax: null,
  loanAmountMin: 2000,
  collectionsMaxPercent: null,
  hourlyLeadCap: null,
  dailyLeadCap: null,
  hourlySpendCapCents: null,
  dailySpendCapCents: null,
  windows: [],
  blackoutDates: [],
  tiers: [{ population: 'engine', debtFrom: 0, debtTo: null, multiplier: 0.001 }],
}
const tripoint: CoverageBuyer = { partnerId: 'p-tripoint', name: 'Tripoint', profile: tripointProfile }
const liberty: CoverageBuyer = {
  partnerId: 'p-liberty1',
  name: 'Liberty1',
  profile: { ...tripointProfile, partnerId: 'p-liberty1', soldOn: 'click', tiers: [], loanAmountMin: 10000, collectionsMaxPercent: 75 },
}

const STATE = '{{trigger.payload.personalInformation.state}}'
const DEBT = '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}'
const LOAN = '{{trigger.payload.loanInformation.loanAmount}}'

/** The Engine flow from 2026-10-13 15:30 to 2026-10-15 12:58 UTC: its buyer_select node had no loan amount template. */
const engine = (selectConfig: Record<string, unknown>, isActive = true) => ({
  id: 'wf-engine',
  name: 'Engine Bidding Workflow',
  is_active: isActive,
  definition: {
    nodes: [
      { id: 'n1', type: 'buyer_select', namespace: 'buyer_select', label: 'Buyer select', config: { mode: 'live', population: 'engine', state: STATE, debt: DEBT, ...selectConfig } },
      { id: 'n2', type: 'buyer_click_check', namespace: 'buyer_click_check', config: { partner_id: 'p-liberty1', population: 'engine', state: STATE, debt: DEBT, loan_amount: LOAN, collections: '{{c}}' } },
    ],
  },
})

describe('findInputGaps', () => {
  it('finds the 2026-10-13 fault: Tripoint\'s 2,000 minimum against an Engine buyer_select with no loan amount template', () => {
    const gaps = findInputGaps([engine({})], [tripoint, liberty])
    expect(gaps).toEqual([
      expect.objectContaining({ workflowId: 'wf-engine', workflowName: 'Engine Bidding Workflow', nodeNamespace: 'buyer_select', nodeType: 'buyer_select', partnerId: 'p-tripoint', buyerName: 'Tripoint', fields: ['loan_amount'] }),
    ])
  })

  it('finds nothing once the node reads the loan amount (Engine version 108 on)', () => {
    expect(findInputGaps([engine({ loan_amount: LOAN })], [tripoint, liberty])).toEqual([])
  })

  it('leaves out a workflow that is switched off, since it judges no lead', () => {
    expect(findInputGaps([engine({}, false)], [tripoint])).toEqual([])
  })

  it('leaves out a buyer the node never judges: one not priced for its population, one switched off, one sold on the click', () => {
    const mainOnly = { ...tripoint, profile: { ...tripointProfile, tiers: [{ population: 'main_flow', debtFrom: 0, debtTo: null, multiplier: 0.001 }] } }
    const off = { ...tripoint, profile: { ...tripointProfile, isEnabled: false } }
    expect(findInputGaps([engine({})], [mainOnly as CoverageBuyer, off, { ...liberty, profile: { ...liberty.profile, collectionsMaxPercent: 75 } }])).toEqual([])
  })

  it('judges a buyer_click_check by the buyer it names, so a collections cap with no collections template is found', () => {
    const wf = engine({ loan_amount: LOAN })
    ;(wf.definition.nodes[1].config as Record<string, unknown>).collections = ''
    expect(findInputGaps([wf], [liberty])).toEqual([
      expect.objectContaining({ nodeType: 'buyer_click_check', nodeNamespace: 'buyer_click_check', partnerId: 'p-liberty1', fields: ['collections'] }),
    ])
  })

  it('names a missing state or debt template too: every lead is refused for those whatever the rules', () => {
    expect(findInputGaps([engine({ loan_amount: LOAN, state: '' })], [tripoint])[0]?.fields).toEqual(['state'])
  })

  it('reads a definition with no node list as one with no buyer steps', () => {
    expect(findInputGaps([{ id: 'w', name: 'W', is_active: true, definition: null }], [tripoint])).toEqual([])
  })
})

describe('the refusal sentences', () => {
  it('a profile save names the workflow, the step, the missing template and the rule, and says nothing was saved', () => {
    const r = inputGapsForProfileSave([engine({})], tripoint)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ code: 'rule_unread_by_live_workflow', path: 'loanAmountMin' })
    expect(r[0].message).toBe(
      'Nothing was saved. The live workflow Engine Bidding Workflow judges this buyer in its step Buyer select, which has no Loan amount template, so a minimum loan amount of 2,000 would refuse every lead it sends as missing a lead field. Add a Loan amount template to that step first, or leave the minimum loan amount blank.'
    )
  })

  it('a workflow save names the step, the buyer, the rule and the missing template', () => {
    const r = inputGapsForWorkflowSave({ id: 'wf-engine', name: 'Engine Bidding Workflow', definition: engine({}).definition }, [tripoint])
    expect(r).toEqual([
      'Step Buyer select has no Loan amount template, and Tripoint\'s buyer profile sets a minimum loan amount of 2,000, so every lead would be refused as missing a lead field. Add the template, or change the profile on the Tripoint partner page first.',
    ])
  })
})
