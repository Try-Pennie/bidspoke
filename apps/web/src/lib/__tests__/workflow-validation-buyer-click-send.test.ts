/**
 * Save time validation for the buyer_click_send node (#1542).
 *
 * The node cannot run without a partner, a prospect id, a request url and body,
 * the partner's success line and a daily cap, so a live workflow must not save
 * without them. Every one of its seven handles can be taken at run time, and
 * an unwired handle the node takes is a named step failure, so all seven must
 * be wired before a live workflow saves (L72).
 */
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS } from '@bidspoke/node-types'
import { findUnwiredRequiredHandles, validateWorkflowDef } from '../workflow-validation'
import type { EdgeDef, NodeDef, NodeType } from '@/types/workflow'

const COMPLETE = {
  partner_id: '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70',
  prospect_id: '{{steps.resolve.output.prospect_id}}',
  request_url: '{{steps.build.output.url}}',
  request_body: '{{steps.build.output.body}}',
  success_pattern: 'Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)',
  daily_lead_cap: 50,
}

function click(config: Record<string, unknown>): NodeDef {
  return { id: 'c1', namespace: 'send_click', label: 'Send click', type: 'buyer_click_send' as NodeType, config }
}
const attached: EdgeDef[] = [{ id: 'e0', source: 'trigger', target: 'c1' }]
const messages = (node: NodeDef) => validateWorkflowDef([node], attached).map((e) => e.message)

describe('buyer_click_send config validation', () => {
  it('a complete config is valid, with the cap as a number or a template', () => {
    expect(messages(click(COMPLETE))).toEqual([])
    expect(messages(click({ ...COMPLETE, daily_lead_cap: '{{steps.profile.output.daily_lead_cap}}' }))).toEqual([])
  })

  const missing: Array<[string, Record<string, unknown>, string]> = [
    ['partner', { partner_id: undefined }, 'No partner selected'],
    ['partner named by slug only, from before #1553', { partner_id: undefined, partner_slug: 'liberty1' }, 'No partner selected'],
    ['prospect id', { prospect_id: '  ' }, 'No prospect id template set'],
    ['request url', { request_url: undefined }, 'No request URL template set'],
    ['request body', { request_body: '' }, 'No request body template set'],
    ['success line', { success_pattern: undefined }, 'No success line set'],
    ['success line with no id group', { success_pattern: 'Records created' }, 'The success line needs an (?<id>...) group'],
    ['success line that is not a pattern', { success_pattern: '(' }, 'The success line is not a valid pattern'],
    ['daily cap', { daily_lead_cap: undefined }, 'No daily lead cap set'],
    ['a zero daily cap', { daily_lead_cap: 0 }, 'No daily lead cap set'],
  ]
  for (const [name, patch, message] of missing) {
    it(`a missing or bad ${name} is unconfigured`, () => {
      expect(messages(click({ ...COMPLETE, ...patch }))).toContain(message)
    })
  }
})

describe('buyer_click_send handles', () => {
  const handles = NODE_TRAITS.buyer_click_send.staticHandles as readonly string[]
  const wire = (hs: readonly string[]): EdgeDef[] => [...attached, ...hs.map((h) => ({ id: `e-${h}`, source: 'c1', target: `t-${h}`, source_handle: h }))]

  it('every handle wired is clean', () => {
    expect(findUnwiredRequiredHandles([click(COMPLETE)], wire(handles)).size).toBe(0)
  })

  it('names every handle left unwired', () => {
    const errors = findUnwiredRequiredHandles([click(COMPLETE)], wire(['sent', 'refused']))
    expect(errors.get('c1')?.message).toBe('Outgoing handle not wired: unknown, already_sent, in_progress, needs_review, not_sent')
  })

  it('still checks buyer_select the way it did', () => {
    const bs: NodeDef = { id: 'b1', namespace: 'bs', label: 'bs', type: 'buyer_select' as NodeType, config: { mode: 'live' } }
    const errors = findUnwiredRequiredHandles([bs], [{ id: 'x', source: 'trigger', target: 'b1' }])
    expect(errors.get('b1')?.message).toBe('Outgoing handle not wired: sold, no_sale, not_applicable')
  })
})
