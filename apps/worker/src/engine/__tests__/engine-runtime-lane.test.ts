/**
 * The engine runs under a runtime naming its lane and two database clients
 * (#1707, plan 0.C):
 * - config reads (the definition, env vars, partner constants, the source
 *   check) go to the config client, and run writes (the execution row, the step
 *   logs) to the run client. The money Worker passes its one client for both;
 *   the ops Worker (0.E) will pass its own database as the run client.
 * - a workflow stored under another lane is refused before anything is
 *   recorded or run, and so is a definition carrying a node type the lane
 *   cannot run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../test-setup/wait-until'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { LoadedWorkflow, WorkflowDefinition } from '../../types'

vi.mock('../definition-loader', async (orig) => ({ ...(await orig<object>()), loadWorkflowDefinition: vi.fn() }))
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

import { executeWorkflow, moneyRuntime, WorkflowLaneError } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { loadEnvVars } from '../../lib/env-loader'
import { loadPartnerConstants } from '../../lib/partner-constants-loader'
import { createExecutionRecord, flushStepLogs, updateExecutionRecord } from '../step-logger'
import { executeNode } from '../nodes/index'
import { LaneRefusedNodeError, TriggerLaneError } from '../lane'
import { ShadowRunRefusedError } from '../run-reality'

const definitionWith = (type: string): WorkflowDefinition =>
  ({
    trigger: { id: 'trigger', type: 'trigger', config: {} },
    nodes: [{ id: 'n', namespace: 'step', type, config: { retries: 0 } }],
    edges: [],
  }) as unknown as WorkflowDefinition

const loaded = (over: Partial<LoadedWorkflow> = {}): LoadedWorkflow => ({
  definition: definitionWith('transform'),
  workflow_version_id: 'v1',
  workflow_name: 'Lane test',
  org_id: 'org-1',
  slack_channel: null,
  lane: 'money',
  ...over,
})

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

const client = (name: string) =>
  ({ name, from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) }) }) as unknown as SupabaseClient

async function run(runtime: Parameters<typeof executeWorkflow>[2], extra: Partial<Parameters<typeof executeWorkflow>[0]> = {}) {
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  const executionCtx = recordingContext()
  try {
    return await executeWorkflow({ triggerType: 'http_webhook', workflowId: 'wf-1707', payload: { lead: 1 }, source: 'engine', ...extra }, env, runtime, executionCtx)
  } finally {
    await executionCtx.settle()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded())
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as never)
})

describe('engine runtime: two clients', () => {
  it('reads config through the config client and writes the run through the run client', async () => {
    const config = client('config')
    const runClient = client('run')
    await run({ lane: 'money', config, run: runClient })

    expect(vi.mocked(loadWorkflowDefinition).mock.calls[0][2]).toBe(config)
    expect(vi.mocked(loadEnvVars).mock.calls[0][2]).toBe(config)
    expect(vi.mocked(loadPartnerConstants).mock.calls[0][2]).toBe(config)
    expect(vi.mocked(createExecutionRecord).mock.calls[0][0]).toBe(runClient)
    expect(vi.mocked(flushStepLogs).mock.calls[0][0]).toBe(runClient)
  })

  it('the money runtime passes one client as both', () => {
    const one = client('main')
    expect(moneyRuntime(one)).toEqual({ lane: 'money', config: one, run: one })
  })
})

describe('engine runtime: the stored lane', () => {
  it('refuses an ops workflow on the money runtime before recording or running anything', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ lane: 'ops' }))
    const err = await run(moneyRuntime(client('main'))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowLaneError)
    expect((err as Error).message).toBe('Workflow wf-1707 runs in the ops lane, not money')
    expect(createExecutionRecord).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('refuses a definition carrying a node type its lane cannot run, before recording anything', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ lane: 'ops', definition: definitionWith('partner_bid') }))
    const err = await run({ lane: 'ops', config: client('c'), run: client('r') }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LaneRefusedNodeError)
    expect(createExecutionRecord).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('runs a money workflow carrying a money node on the money runtime', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ definition: definitionWith('salesforce') }))
    const result = await run(moneyRuntime(client('main')))
    expect(result.status).toBe(200)
    expect(executeNode).toHaveBeenCalledTimes(1)
  })
})

// workflow_executions.trigger_type is what started the run (#1947, A1b), named
// by the entry point that started it rather than a constant in the step
// logger, so a run started some other way can never be recorded as a webhook.
// The value reaches the created row and the create fields finalize rebuilds a
// lost row from, so the two cannot disagree.
describe('engine: a run records the trigger that started it (#1947)', () => {
  const recorded = () => ({
    created: (vi.mocked(createExecutionRecord).mock.calls[0]?.[1] as { trigger_type?: unknown } | undefined)?.trigger_type,
    rebuildable: (vi.mocked(updateExecutionRecord).mock.calls[0]?.[4] as { trigger_type?: unknown } | undefined)?.trigger_type,
  })

  it('records an http webhook run as http_webhook on the money runtime', async () => {
    await run(moneyRuntime(client('main')), { triggerType: 'http_webhook' })
    expect(recorded()).toEqual({ created: 'http_webhook', rebuildable: 'http_webhook' })
  })

  it('records a scheduled run as schedule on the ops runtime', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ lane: 'ops' }))
    await run({ lane: 'ops', config: client('c'), run: client('r') }, { triggerType: 'schedule' })
    expect(recorded()).toEqual({ created: 'schedule', rebuildable: 'schedule' })
  })

  it('refuses a run started by a trigger its lane does not run, before recording anything', async () => {
    const err = await run(moneyRuntime(client('main')), { triggerType: 'schedule' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TriggerLaneError)
    expect((err as Error).message).toBe('A schedule trigger does not start runs in the money lane')
    expect(createExecutionRecord).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })
})

describe('engine: a shadow run of code needs its compare bundle (#1780, #1708)', () => {
  it('refuses a shadow run of a workflow carrying a code node with no compare bundle, before recording or running anything', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ definition: definitionWith('code') }))
    const err = await run(moneyRuntime(client('main')), { isTest: true, shadowMode: 'dry_run' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ShadowRunRefusedError)
    expect((err as Error).message).toContain('step is a code node')
    expect(createExecutionRecord).not.toHaveBeenCalled()
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('runs a shadow of a workflow carrying a code node once its compare bundle is named', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ definition: definitionWith('code') }))
    const result = await run(moneyRuntime(client('main')), { isTest: true, shadowMode: 'dry_run', codeBundleName: 'bs-cmp-wf-1707-0123abcd' })
    expect(result.status).toBe(200)
    expect(executeNode).toHaveBeenCalledTimes(1)
  })

  it('refuses a test run override carrying a code node too, since that is what would run', async () => {
    const override = definitionWith('code')
    const err = await run(moneyRuntime(client('main')), { isTest: true, shadowMode: 'dry_run', definitionOverride: override }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ShadowRunRefusedError)
    expect(executeNode).not.toHaveBeenCalled()
  })

  it('still runs a shadow of a workflow with no code node, with no bundle', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ definition: definitionWith('salesforce') }))
    const result = await run(moneyRuntime(client('main')), { isTest: true, shadowMode: 'dry_run' })
    expect(result.status).toBe(200)
    expect(executeNode).toHaveBeenCalledTimes(1)
  })

  it('still runs a live run of a workflow carrying a code node', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded({ definition: definitionWith('code') }))
    const result = await run(moneyRuntime(client('main')))
    expect(result.status).toBe(200)
    expect(executeNode).toHaveBeenCalledTimes(1)
  })
})
