/**
 * The step observer (#1305): an optional hook on the engine runtime that receives
 * each step record as the engine queues it.
 *
 * The outage drill reads a run's decisions (routes, nodes, final node) from it,
 * because in a database outage the engine never writes the step rows at all: the
 * flush is chained on the execution record insert, which fails. Reading decisions
 * from the writes would leave the drill nothing to compare in exactly the case it
 * exists for. Production never sets the hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'

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

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { createExecutionRecord, flushStepLogs } from '../step-logger'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [
    { id: 'a', namespace: 'first', type: 'transform', config: {} },
    { id: 'b', namespace: 'second', type: 'transform', config: {} },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b' }],
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

async function run(observeStep?: (entry: StepLogEntry) => void) {
  const background: Promise<unknown>[] = []
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  await executeWorkflow(
    { workflowId: 'wf-obs', payload: { lead: 1 }, source: 'engine' },
    env,
    { ...moneyRuntime(supabase), ...(observeStep ? { observeStep } : {}) },
    { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) },
  )
  await Promise.all(background.splice(0))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createExecutionRecord).mockResolvedValue(undefined)
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition, workflow_version_id: 'v1', workflow_name: 'Observer', org_id: 'org-1', slack_channel: null, lane: 'money',
  })
  vi.mocked(executeNode).mockImplementation(async (node) => ({ output: { _route: `${(node as { namespace: string }).namespace}-route` } }) as never)
})

describe('runtime.observeStep (#1305)', () => {
  it('receives every step the engine queues, in order, as the flush writes them', async () => {
    const seen: StepLogEntry[] = []
    await run((entry) => seen.push(entry))
    expect(seen.map((s) => s.step_namespace)).toEqual(['first', 'second'])
    expect(seen.map((s) => (s.output as { _route?: string })._route)).toEqual(['first-route', 'second-route'])
    const flushed = vi.mocked(flushStepLogs).mock.calls[0]?.[1] as StepLogEntry[]
    expect(flushed).toEqual(seen)
  })

  it('still reports every step when the execution record cannot be written, so nothing is flushed', async () => {
    vi.mocked(createExecutionRecord).mockRejectedValue(new Error('database down'))
    const seen: StepLogEntry[] = []
    await run((entry) => seen.push(entry))
    expect(flushStepLogs).not.toHaveBeenCalled()
    expect(seen.map((s) => s.step_namespace)).toEqual(['first', 'second'])
  })

  it('changes nothing when no observer is set', async () => {
    await run()
    const flushed = vi.mocked(flushStepLogs).mock.calls[0]?.[1] as StepLogEntry[]
    expect(flushed.map((s) => s.step_namespace)).toEqual(['first', 'second'])
  })
})
