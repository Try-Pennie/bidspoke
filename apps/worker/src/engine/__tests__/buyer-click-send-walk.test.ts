/**
 * The walker's buyer_click_send block (#1542): one step row under the node's
 * id, routing by the handle the executor chose, a NAMED failure when that
 * handle is not wired, and the executor's own failure failing the step. The
 * executor is mocked here; its behaviour is nodes/__tests__/buyer-click-send.test.ts.
 *
 * Plus the one fact the executor cannot see for itself: executeWorkflow marks a
 * resumed or replayed run on the context, which is what the node refuses on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerClickSendOutput, BuyerClickSendResult, BuyerClickSendRoute } from '../nodes/buyer-click-send'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/buyer-click-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-send')>()),
  executeBuyerClickSendNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/index', () => ({
  executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { reached: node.namespace } })),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { BUYER_CLICK_SEND_ROUTES, executeBuyerClickSendNode } from '../nodes/buyer-click-send'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const NODE_ID = '0192a4f0-0000-7000-8000-00000000c11c'

const send: NodeDefinition = { id: NODE_ID, namespace: 'send_click', type: 'buyer_click_send', config: { partner_id: '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70' } }
const after = (route: string): NodeDefinition => ({ id: `n-${route}`, namespace: `after_${route}`, type: 'code', config: {} })

function definition(wired: readonly BuyerClickSendRoute[]) {
  const edges: EdgeDefinition[] = wired.map((handle) => ({ id: `e-${handle}`, source: NODE_ID, target: `n-${handle}`, source_handle: handle }))
  return { nodes: [send, ...BUYER_CLICK_SEND_ROUTES.map(after)], edges }
}

function output(route: BuyerClickSendRoute): BuyerClickSendOutput {
  return {
    _route: route, reason: route === 'sent' ? 'sent' : 'outcome_unknown', mode_effective: 'live', partner_id: '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70', partner_slug: 'liberty1', prospect_id: 'p-1',
    status: 200, partner_lead_id: null, count: null, counted: false, count_date: null, over_cap: null, pages: [], duration_ms: 5,
  }
}

const walk = (def: ReturnType<typeof definition>, queue: StepLogEntry[] = []) =>
  walkGraph(buildContext({ prospect: 'p-1' }, 'liberty-proxy', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1'), def, 'exec-1', '2027-09-20T18:00:00.000Z', supabase, env, 'v1', queue)

beforeEach(() => {
  vi.mocked(executeBuyerClickSendNode).mockReset()
})

describe('buyer_click_send in the walker', () => {
  it('follows each route to its own handle and writes one step row under the node id', async () => {
    for (const route of BUYER_CLICK_SEND_ROUTES) {
      vi.mocked(executeBuyerClickSendNode).mockResolvedValue({ output: output(route) })
      const queue: StepLogEntry[] = []
      const result = await walk(definition(BUYER_CLICK_SEND_ROUTES), queue)
      expect(result.body, route).toEqual({ reached: `after_${route}` })
      const rows = queue.filter((r) => r.step_node_id === NODE_ID)
      expect(rows.map((r) => [r.step_type, r.status]), route).toEqual([['buyer_click_send', 'completed']])
    }
  })

  it('runs the executor exactly once: never through the retry loop', async () => {
    vi.mocked(executeBuyerClickSendNode).mockResolvedValue({ output: output('sent') })
    await walk(definition(BUYER_CLICK_SEND_ROUTES))
    expect(executeBuyerClickSendNode).toHaveBeenCalledTimes(1)
  })

  it('an unwired handle fails the step by name and follows nothing', async () => {
    vi.mocked(executeBuyerClickSendNode).mockResolvedValue({ output: output('unknown') })
    const queue: StepLogEntry[] = []
    await expect(walk(definition(['sent']), queue)).rejects.toThrow(/buyer_click_send_handle_unwired.*unknown/)
    expect(queue.find((r) => r.step_type === 'buyer_click_send')).toMatchObject({ status: 'failed', error_type: 'permanent' })
    expect(queue.find((r) => r.step_namespace === 'after_sent')).toBeUndefined()
  })

  it('the executor failure fails the step with its message and type', async () => {
    const failed: BuyerClickSendResult = { output: output('not_sent'), failure: { message: 'buyer_click_send claim_unavailable: nothing was sent', errorType: 'transient', reason: 'claim_unavailable' } }
    vi.mocked(executeBuyerClickSendNode).mockResolvedValue(failed)
    const queue: StepLogEntry[] = []
    await expect(walk(definition(BUYER_CLICK_SEND_ROUTES), queue)).rejects.toThrow(/claim_unavailable/)
    expect(queue.find((r) => r.step_type === 'buyer_click_send')).toMatchObject({ status: 'failed', error_type: 'transient' })
  })
})

describe('executeWorkflow marks a recovery run on the context', () => {
  it('resume and replay each set ctx.recovery, and a fresh run leaves it unset', async () => {
    vi.resetModules()
    vi.doMock('../definition-loader', () => ({
      loadWorkflowDefinition: vi.fn().mockResolvedValue({
        definition: { trigger: { id: 't', type: 'trigger', config: {} }, nodes: [{ id: 'a', namespace: 'a', type: 'code', config: { retries: 0 } }], edges: [] },
        org_id: 'org-1', workflow_version_id: 'v1', workflow_name: 'wf', is_active: true,
      }),
    }))
    vi.doMock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
    vi.doMock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
    vi.doMock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
    const seen: Array<ExecutionContext['recovery']> = []
    vi.doMock('../nodes/index', () => ({
      executeNode: vi.fn(async (_node: NodeDefinition, c: ExecutionContext) => {
        seen.push(c.recovery)
        return { output: { ok: true } }
      }),
    }))
    const { executeWorkflow } = await import('../index')
    const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined } as unknown as KVNamespace
    const e = { IDEMPOTENCY: kv, WORKFLOW_CACHE: kv, APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
    const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }) } as unknown as SupabaseClient
    const ec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) }
    const base = { workflowId: 'wf-1', payload: { prospect: 'p-1' }, source: 's' }
    await executeWorkflow(base, e, sb, ec)
    await executeWorkflow({ ...base, resumeFromExecutionId: 'orig-1' }, e, sb, ec)
    await executeWorkflow({ ...base, parentExecutionId: 'orig-1' }, e, sb, ec)
    expect(seen).toEqual([undefined, 'resume', 'replay'])
  })
})
