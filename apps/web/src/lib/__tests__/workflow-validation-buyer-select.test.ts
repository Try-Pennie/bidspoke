/**
 * Save time validation for the buyer_select node (#1411).
 *
 * Two rules. The node's required config, which is what blocks saving an
 * unconfigured live workflow: population, mode, lead key, sell off condition and
 * the sale payload base. And its handles: a live workflow must wire sold,
 * no_sale and not_applicable, and deferred whenever the node can route there
 * (decide only mode, or a live share variable set), because an unwired handle
 * the node needs to take is a named step failure at run time, and a person
 * should hear that at save time instead (L72).
 */
import { describe, expect, it } from 'vitest'
import { findUnwiredBuyerSelectHandles, validateWorkflowDef } from '../workflow-validation'
import type { EdgeDef, NodeDef, NodeType } from '@/types/workflow'

const COMPLETE = {
  population: 'engine',
  mode: 'decide_only',
  lead_key: '{{trigger.payload.leadUuid}}',
  sell_off_when: '{{steps.prospect_trades.output.body.sellOff}}',
  sale_payload: { base: '{{trigger.payload}}', set: [], normalise: [] },
}

function buyerSelect(config: Record<string, unknown>): NodeDef {
  return { id: 'bs1', namespace: 'buyer_select_1', label: 'Sell off', type: 'buyer_select' as NodeType, config }
}
const attached: EdgeDef[] = [{ id: 'e1', source: 'trigger', target: 'bs1' }]
const messages = (node: NodeDef) => validateWorkflowDef([node], attached).map((e) => e.message)

describe('buyer_select config validation', () => {
  it('a complete config is valid', () => {
    expect(messages(buyerSelect(COMPLETE))).toEqual([])
  })

  it('a missing mode is unconfigured', () => {
    expect(messages(buyerSelect({ ...COMPLETE, mode: undefined }))).toContain('No mode set (decide only or live)')
  })

  it('an unknown mode is unconfigured, not waved through (L72)', () => {
    expect(messages(buyerSelect({ ...COMPLETE, mode: 'canary' }))).toContain('No mode set (decide only or live)')
  })

  it.each([
    ['population', 'No population selected'],
    ['lead_key', 'No lead key template set'],
    ['sell_off_when', 'No sell off condition set'],
  ])('a blank %s is unconfigured', (field, message) => {
    expect(messages(buyerSelect({ ...COMPLETE, [field]: '  ' }))).toContain(message)
  })

  it('a sale payload with no base is unconfigured', () => {
    expect(messages(buyerSelect({ ...COMPLETE, sale_payload: { set: [] } }))).toContain('No sale payload base set')
    expect(messages(buyerSelect({ ...COMPLETE, sale_payload: undefined }))).toContain('No sale payload base set')
  })
})

describe('buyer_select handle wiring for a live workflow', () => {
  const node = (config: Record<string, unknown>) => buyerSelect(config)
  const edge = (handle: string): EdgeDef => ({ id: `e-${handle}`, source: 'bs1', target: `t-${handle}`, source_handle: handle })
  const wired = (...handles: string[]): EdgeDef[] => [...attached, ...handles.map(edge)]

  it('decide only needs all four handles wired', () => {
    const errors = findUnwiredBuyerSelectHandles([node({ ...COMPLETE, mode: 'decide_only' })], wired('sold', 'no_sale', 'not_applicable'))
    expect([...errors.values()].map((e) => e.message)).toEqual(['Outgoing handle not wired: deferred'])
  })

  it('live with a live share variable needs deferred too', () => {
    const errors = findUnwiredBuyerSelectHandles([node({ ...COMPLETE, mode: 'live', live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' })], wired('sold', 'no_sale', 'not_applicable'))
    expect([...errors.values()].map((e) => e.message)).toEqual(['Outgoing handle not wired: deferred'])
  })

  it('live with no live share variable needs only the three', () => {
    const errors = findUnwiredBuyerSelectHandles([node({ ...COMPLETE, mode: 'live' })], wired('sold', 'no_sale', 'not_applicable'))
    expect(errors.size).toBe(0)
  })

  it('names every missing handle at once, and only for attached buyer_select nodes', () => {
    const errors = findUnwiredBuyerSelectHandles([node({ ...COMPLETE, mode: 'live' })], wired('sold'))
    expect([...errors.values()].map((e) => e.message)).toEqual(['Outgoing handle not wired: no_sale, not_applicable'])
    const detached = findUnwiredBuyerSelectHandles([node({ ...COMPLETE, mode: 'live' })], [])
    expect(detached.size).toBe(0)
  })
})
