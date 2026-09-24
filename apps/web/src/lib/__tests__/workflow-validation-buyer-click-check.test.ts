/**
 * Save time validation for the buyer_click_check node (#1543).
 *
 * The node cannot decide without its buyer (by partner id), the lead's state,
 * debt and loan amount templates, and the population it runs on, so a live
 * workflow must not save without them. Both of its handles can be taken at run
 * time, and an unwired handle the node takes is a named step failure, so both
 * must be wired (L72). The partner id is refused at save by the same package
 * rule the executor refuses it by.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS } from '@bidspoke/node-types'
import { partnerIdOf } from '@bidspoke/buyer-profile'
import { findUnwiredRequiredHandles, validateWorkflowDef } from '../workflow-validation'
import type { EdgeDef, NodeDef, NodeType } from '@/types/workflow'

const COMPLETE = {
  partner_id: '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70',
  state: '{{trigger.payload.state}}',
  debt: '{{steps.trades.output.tradeCalculations.engineDebt}}',
  loan_amount: '{{trigger.payload.loanInformation.loanAmount}}',
  population: 'engine',
}

function check(config: Record<string, unknown>): NodeDef {
  return { id: 'k1', namespace: 'liberty1_check', label: 'Liberty1 check', type: 'buyer_click_check' as NodeType, config }
}
const attached: EdgeDef[] = [{ id: 'e0', source: 'trigger', target: 'k1' }]
const messages = (node: NodeDef) => validateWorkflowDef([node], attached).map((e) => e.message)

describe('buyer_click_check config validation', () => {
  it('a complete config is valid', () => {
    expect(messages(check(COMPLETE))).toEqual([])
  })

  const missing: Array<[string, Record<string, unknown>, string]> = [
    ['partner', { partner_id: undefined }, 'No partner selected'],
    ['partner stored as a slug', { partner_id: 'liberty1' }, 'The partner is not a partner id; pick the buyer again'],
    ['state', { state: ' ' }, 'No state template set'],
    ['debt', { debt: undefined }, 'No debt template set'],
    ['loan amount', { loan_amount: '' }, 'No loan amount template set'],
    ['population', { population: undefined }, 'No population selected'],
    ['population outside the vocabulary', { population: 'enginee' }, 'enginee is not a population Bidspoke knows'],
  ]
  for (const [name, patch, message] of missing) {
    it(`a missing or bad ${name} is unconfigured`, () => {
      expect(messages(check({ ...COMPLETE, ...patch }))).toContain(message)
    })
  }

  const values: unknown[] = [COMPLETE.partner_id, ` ${COMPLETE.partner_id}`, 'liberty1', '', undefined, 3]
  for (const value of values) {
    it(`the partner id rule agrees with the executor's on ${JSON.stringify(value ?? null)}`, () => {
      const refusedAtSave = messages(check({ ...COMPLETE, partner_id: value })).some((m) => m === 'No partner selected' || m.startsWith('The partner is not a partner id'))
      expect(refusedAtSave).toBe(!partnerIdOf(value).ok)
    })
  }
})

describe('buyer_click_check handles', () => {
  const handles = NODE_TRAITS.buyer_click_check.staticHandles as readonly string[]
  const wire = (hs: readonly string[]): EdgeDef[] => [...attached, ...hs.map((h) => ({ id: `e-${h}`, source: 'k1', target: `t-${h}`, source_handle: h }))]

  it('both handles wired is clean', () => {
    expect(findUnwiredRequiredHandles([check(COMPLETE)], wire(handles)).size).toBe(0)
  })

  it('names the handle left unwired', () => {
    expect(findUnwiredRequiredHandles([check(COMPLETE)], wire(['eligible'])).get('k1')?.message).toBe('Outgoing handle not wired: not_eligible')
  })
})
