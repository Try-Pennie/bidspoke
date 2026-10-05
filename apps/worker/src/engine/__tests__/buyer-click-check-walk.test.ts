/**
 * The walker's buyer_click_check block (#1543): one step row under the node's
 * id, routing by the handle the executor chose, a NAMED failure when that
 * handle is not wired, the executor's own failure failing the step, and the
 * executor run exactly once. The executor is mocked here; its behaviour is
 * nodes/__tests__/buyer-click-check.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerClickCheckOutput, BuyerClickCheckRoute } from '../nodes/buyer-click-check'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/buyer-click-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-check')>()),
  executeBuyerClickCheckNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { reached: node.namespace } })),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { BUYER_CLICK_CHECK_ROUTES, executeBuyerClickCheckNode } from '../nodes/buyer-click-check'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const NODE_ID = '0192a4f0-0000-7000-8000-00000000c1ec'
const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

const check: NodeDefinition = { id: NODE_ID, namespace: 'liberty1_check', type: 'buyer_click_check', config: { partner_id: PARTNER_ID, population: 'engine' } }
const after = (route: string): NodeDefinition => ({ id: `n-${route}`, namespace: `after_${route}`, type: 'code', config: {} })

function definition(wired: readonly BuyerClickCheckRoute[]) {
  const edges: EdgeDefinition[] = wired.map((handle) => ({ id: `e-${handle}`, source: NODE_ID, target: `n-${handle}`, source_handle: handle }))
  return { nodes: [check, ...BUYER_CLICK_CHECK_ROUTES.map(after)], edges }
}

function output(route: BuyerClickCheckRoute): BuyerClickCheckOutput {
  return {
    _route: route, reason: route === 'eligible' ? 'eligible' : 'daily_lead_cap', population: 'engine', partner_id: PARTNER_ID, partner_slug: 'liberty1', partner_name: 'Liberty1',
    click_url: 'https://trypennie.com/portal/libertyone/{prospect_id}', external_routing_code: 4, count: 12, daily_lead_cap: 50, count_date: '2027-09-21', count_source: 'counter', profile_served_from: 'cache',
    judged: { lead: { state: 'TX', debt: 25000, loan_amount: 5000 }, limits: null }, duration_ms: 4,
  }
}

const walk = (def: ReturnType<typeof definition>, queue: StepLogEntry[] = []) =>
  walkGraph(buildContext({ state: 'TX' }, 'engine', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1'), def, 'exec-1', '2027-09-21T18:00:00.000Z', supabase, env, 'money', 'v1', queue)

beforeEach(() => {
  vi.mocked(executeBuyerClickCheckNode).mockReset()
})

describe('buyer_click_check in the walker', () => {
  it('follows each route to its own handle and writes one step row under the node id', async () => {
    for (const route of BUYER_CLICK_CHECK_ROUTES) {
      vi.mocked(executeBuyerClickCheckNode).mockResolvedValue({ output: output(route) })
      const queue: StepLogEntry[] = []
      const result = await walk(definition(BUYER_CLICK_CHECK_ROUTES), queue)
      expect(result.body, route).toEqual({ reached: `after_${route}` })
      const rows = queue.filter((r) => r.step_node_id === NODE_ID)
      expect(rows.map((r) => [r.step_type, r.status]), route).toEqual([['buyer_click_check', 'completed']])
    }
  })

  it('runs the executor exactly once: never through the retry loop', async () => {
    vi.mocked(executeBuyerClickCheckNode).mockResolvedValue({ output: output('eligible') })
    await walk(definition(BUYER_CLICK_CHECK_ROUTES))
    expect(executeBuyerClickCheckNode).toHaveBeenCalledTimes(1)
  })

  it('an unwired handle fails the step by name and follows nothing', async () => {
    vi.mocked(executeBuyerClickCheckNode).mockResolvedValue({ output: output('not_eligible') })
    const queue: StepLogEntry[] = []
    await expect(walk(definition(['eligible']), queue)).rejects.toThrow(/buyer_click_check_handle_unwired.*not_eligible/)
    expect(queue.find((r) => r.step_type === 'buyer_click_check')).toMatchObject({ status: 'failed', error_type: 'permanent' })
    expect(queue.find((r) => r.step_namespace === 'after_eligible')).toBeUndefined()
  })

  it('the executor failure fails the step with its message and type', async () => {
    vi.mocked(executeBuyerClickCheckNode).mockResolvedValue({ output: output('not_eligible'), failure: { message: 'buyer_click_check partner_id_invalid: partner_id "tripoint" is not a partner id', errorType: 'permanent', reason: 'partner_id_invalid' } })
    const queue: StepLogEntry[] = []
    await expect(walk(definition(BUYER_CLICK_CHECK_ROUTES), queue)).rejects.toThrow(/partner_id_invalid/)
    expect(queue.find((r) => r.step_type === 'buyer_click_check')).toMatchObject({ status: 'failed', error_type: 'permanent' })
  })
})
