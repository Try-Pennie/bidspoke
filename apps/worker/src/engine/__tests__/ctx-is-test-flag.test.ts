/**
 * #547: node executors only ever see the ExecutionContext, so the Test Runner flag has
 * to ride along on it. The circuit-breaker trip alert is the reason: a test run against
 * a live partner can genuinely trip a breaker, and without this flag the executor pages
 * ops exactly like a production incident.
 *
 * The gate itself is tested in nodes/__tests__/partner-bid-circuit-alert.test.ts against
 * the real executor. This covers the one link that test cannot: that executeWorkflow
 * actually puts options.isTest onto the context. If it did not, the gate would be dead
 * code and the alert would keep firing, silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { ExecutionContext, WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'n', namespace: 'bid', type: 'salesforce', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

const supabase = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) }) } as unknown as SupabaseClient

async function runWith(isTest?: boolean): Promise<ExecutionContext> {
  const background: Promise<unknown>[] = []
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }

  await executeWorkflow(
    { workflowId: 'wf-547', payload: { lead: 1 }, source: 'engine', ...(isTest === undefined ? {} : { isTest }) },
    env,
    supabase,
    executionCtx,
  )
  await Promise.all(background.splice(0))

  // executeNode(node, ctx, env, supabase, signal): the context is the 2nd argument.
  const call = vi.mocked(executeNode).mock.calls[0]
  expect(call, 'the workflow did not execute a node').toBeDefined()
  return call[1] as ExecutionContext
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Ctx Flag Test',
    org_id: 'org-1',
    slack_channel: null,
  })
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as never)
})

describe('ExecutionContext.isTest (#547)', () => {
  it('carries the Test Runner flag through to node executors', async () => {
    const ctx = await runWith(true)
    expect(ctx.isTest).toBe(true)
  })

  it('leaves it unset on a production run, so real trips still alert', async () => {
    const ctx = await runWith()
    expect(ctx.isTest).toBeFalsy()
  })
})
