/**
 * The walker's buyer_select block (#1411): one parent step row plus one
 * `partner_bid` child row per attempted buyer, both under the node's REAL id
 * and linked by parallel_group_id (the bid_group pattern), routing by the
 * handle the executor chose, and a NAMED failure when that handle is not wired
 * in any mode. The executor itself is mocked: its behaviour is covered in
 * nodes/__tests__/buyer-select.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { NodeDefinition, EdgeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerSelectResult } from '../nodes/buyer-select'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/buyer-select', () => ({
  executeBuyerSelectNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { reached: node.namespace } })),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { executeBuyerSelectNode } from '../nodes/buyer-select'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const NODE_ID = '0192a4f0-0000-7000-8000-00000000b5e1'

const select: NodeDefinition = { id: NODE_ID, namespace: 'sell_off', type: 'buyer_select', config: { population: 'engine', mode: 'live', lead_key: '{{trigger.payload.leadUuid}}', sell_off_when: '{{trigger.payload.sellOff}}' } }
const onSold: NodeDefinition = { id: 'n-sold', namespace: 'after_sold', type: 'code', config: {} }
const onNoSale: NodeDefinition = { id: 'n-nosale', namespace: 'after_no_sale', type: 'code', config: {} }
const onDeferred: NodeDefinition = { id: 'n-deferred', namespace: 'after_deferred', type: 'code', config: {} }
const onNa: NodeDefinition = { id: 'n-na', namespace: 'after_not_applicable', type: 'code', config: {} }

function definition(wired: Array<'sold' | 'no_sale' | 'deferred' | 'not_applicable'>) {
  const targets = { sold: onSold, no_sale: onNoSale, deferred: onDeferred, not_applicable: onNa }
  const edges: EdgeDefinition[] = wired.map((handle) => ({ id: `e-${handle}`, source: NODE_ID, target: targets[handle].id, source_handle: handle }))
  return { nodes: [select, onSold, onNoSale, onDeferred, onNa], edges }
}

function outputFor(route: BuyerSelectResult['output']['_route'], reason: BuyerSelectResult['output']['reason']): BuyerSelectResult['output'] {
  return {
    _route: route, reason, mode_effective: 'live', population: 'engine', lead_key: 'lead-1',
    sale: {
      skipped: route !== 'sold', accepted: route === 'sold', buyer_reference: route === 'sold' ? 'L-1' : null, result_code: route === 'sold' ? '1000' : null, partner_slug: route === 'sold' ? 'tripoint' : null,
      partner_name: route === 'sold' ? 'Tripoint' : null, click_url: route === 'sold' ? 'https://trypennie.com/portal/tpl' : null, routing_code: route === 'sold' ? 2 : null, response_class: route === 'sold' ? 'Success' : null,
    },
    considered: [], live_percent_in_force: 100, caps_in_force: [], duration_ms: 12,
  }
}

const attempt = (slug: string, status: 'completed' | 'failed', over: Partial<BuyerSelectResult['attempts'][number]> = {}): BuyerSelectResult['attempts'][number] => ({
  partner_slug: slug, namespace: `sell_off.${slug}`, status,
  input: { partner_slug: slug, kind: 'live', lead_key: 'lead-1', payout_cents: 2190, priority: 1 },
  output: { outcome: status === 'completed' ? 'accepted' : 'outcome_unknown', partner_slug: slug },
  error: status === 'failed' ? 'held' : null, error_type: status === 'failed' ? 'transient' : null,
  started_at: new Date('2027-09-20T15:30:00.000Z'), completed_at: new Date('2027-09-20T15:30:01.000Z'),
  ...over,
})

const walk = (def: ReturnType<typeof definition>, queue: StepLogEntry[] = []) =>
  walkGraph(buildContext({ leadUuid: 'lead-1', sellOff: true }, 'engine', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1'), def, 'exec-1', '2027-09-20T15:30:00.000Z', supabase, env, 'money', 'v1', queue)

beforeEach(() => {
  vi.mocked(executeBuyerSelectNode).mockReset()
})

describe('buyer_select in the walker', () => {
  it('writes the parent row and one partner_bid child per attempt, all under the node id, linked by parallel_group_id, then follows the sold handle', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output: outputFor('sold', 'sold'), attempts: [attempt('liberty', 'completed', { output: { outcome: 'declined_by_buyer' } }), attempt('tripoint', 'completed')] })
    const queue: StepLogEntry[] = []
    const result = await walk(definition(['sold', 'no_sale', 'not_applicable', 'deferred']), queue)

    expect(result.body).toEqual({ reached: 'after_sold' })
    const rows = queue.filter((r) => r.step_node_id === NODE_ID)
    expect(rows.map((r) => [r.step_type, r.step_namespace, r.status, r.parallel_group_id ?? null])).toEqual([
      ['partner_bid', 'sell_off.liberty', 'completed', NODE_ID],
      ['partner_bid', 'sell_off.tripoint', 'completed', NODE_ID],
      ['buyer_select', 'sell_off', 'completed', null],
    ])
    const parent = rows.find((r) => r.step_type === 'buyer_select')!
    expect((parent.output as Record<string, unknown>)._route).toBe('sold')
    // The children come first in step order and the parent takes the order it was allocated before them.
    expect(parent.step_order).toBeLessThan(rows[0].step_order)
    expect(queue.find((r) => r.step_namespace === 'after_sold')).toBeTruthy()
    expect(queue.find((r) => r.step_namespace === 'after_no_sale')).toBeUndefined()
  })

  it('routes no_sale, deferred and not_applicable to their own handles', async () => {
    for (const [route, reason, expected] of [
      ['no_sale', 'declined_by_buyer', 'after_no_sale'],
      ['deferred', 'canary_out', 'after_deferred'],
      ['not_applicable', 'sell_off_false', 'after_not_applicable'],
    ] as const) {
      vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output: outputFor(route, reason), attempts: [] })
      const result = await walk(definition(['sold', 'no_sale', 'not_applicable', 'deferred']))
      expect(result.body, route).toEqual({ reached: expected })
    }
  })

  it('an unwired handle the node took fails the step by name and never follows sold', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output: outputFor('no_sale', 'declined_by_buyer'), attempts: [attempt('tripoint', 'completed', { output: { outcome: 'declined_by_buyer' } })] })
    const queue: StepLogEntry[] = []
    await expect(walk(definition(['sold']), queue)).rejects.toThrow(/buyer_select_handle_unwired.*no_sale/)
    const parent = queue.find((r) => r.step_type === 'buyer_select')!
    expect(parent.status).toBe('failed')
    expect(parent.error_message).toMatch(/buyer_select_handle_unwired/)
    expect(queue.find((r) => r.step_namespace === 'after_sold')).toBeUndefined()
    // The attempt that ran is still recorded: the failure is the wiring, not the sale.
    expect(queue.filter((r) => r.step_type === 'partner_bid')).toHaveLength(1)
  })

  it('a failure from the executor fails the step with its own message and type, after writing the rows', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({
      output: outputFor('no_sale', 'outcome_unknown'),
      attempts: [attempt('tripoint', 'failed')],
      failure: { message: 'buyer_select outcome_unknown: buyer answered http 504', errorType: 'transient', reason: 'outcome_unknown' },
    })
    const queue: StepLogEntry[] = []
    await expect(walk(definition(['sold', 'no_sale', 'not_applicable', 'deferred']), queue)).rejects.toThrow(/outcome_unknown: buyer answered http 504/)
    const child = queue.find((r) => r.step_type === 'partner_bid')!
    expect(child).toMatchObject({ status: 'failed', error_type: 'transient', error_message: 'held' })
    const parent = queue.find((r) => r.step_type === 'buyer_select')!
    expect(parent).toMatchObject({ status: 'failed', error_type: 'transient' })
    expect(queue.find((r) => r.step_namespace === 'after_no_sale')).toBeUndefined()
  })

  it('never puts the sale payload in a row: the child input is the attempt summary the executor built', async () => {
    vi.mocked(executeBuyerSelectNode).mockResolvedValue({ output: outputFor('sold', 'sold'), attempts: [attempt('tripoint', 'completed')] })
    const queue: StepLogEntry[] = []
    await walk(definition(['sold', 'no_sale', 'not_applicable', 'deferred']), queue)
    const child = queue.find((r) => r.step_type === 'partner_bid')!
    expect(JSON.stringify(child.input)).not.toContain('ssn')
    expect((child.input as { resolved: Record<string, unknown> }).resolved).toMatchObject({ partner_slug: 'tripoint', payout_cents: 2190 })
  })
})
