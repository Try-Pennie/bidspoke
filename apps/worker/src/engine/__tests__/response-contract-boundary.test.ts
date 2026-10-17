/**
 * The response contract check is actually WIRED at the response boundary (#933).
 *
 * The contract module has its own suite. This one exists because a check nobody
 * calls is indistinguishable from no check at all, and the suite for the pure
 * function passes either way (L3: built is not wired).
 *
 * It drives the real `executeWorkflow` and asserts on what the engine emits, so
 * it also pins the thing the module cannot know on its own: that the boundary
 * covers every branch that assigns a response, including the engine-error body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../../test-setup/wait-until'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition, NodeDefinition } from '../../types'
import { RESPONSE_CONTRACT_EVENTS } from '../response-contracts'

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

/** A workflow that HAS a declared contract, so the boundary has something to judge. */
const LEAD_ECONOMY = '89b1a6af-7e0f-43de-bc66-1e888184551f'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'reject_response', type: 'response', config: { retries: 0 } }],
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

function run(workflowId: string) {
  const env = {
    IDEMPOTENCY: makeKV(),
    WORKFLOW_CACHE: makeKV(),
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
  } as unknown as Env
  const executionCtx = recordingContext()
  return {
    result: executeWorkflow({ workflowId, payload: { lead: 1 }, source: 'engine' }, env, moneyRuntime({} as SupabaseClient), executionCtx),
    flush: async () => {
      await executionCtx.settle()
    },
  }
}

/** The structured lines the boundary emitted, parsed. */
const emitted = (
  err: ReturnType<typeof vi.spyOn>,
  warn: ReturnType<typeof vi.spyOn>,
): Record<string, unknown>[] =>
  [...err.mock.calls, ...warn.mock.calls]
    .map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((o) => typeof o.event === 'string' && String(o.event).startsWith('response_contract'))

describe('the response boundary', () => {
  let err: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition,
      workflow_version_id: 'v1',
      workflow_name: 'Contract Boundary Test',
      org_id: 'org-1',
      slack_channel: null, lane: 'money',
    })
  })
  afterEach(() => vi.restoreAllMocks())

  // The mock has to return a StepExecutionResult, so the response body sits
  // under `output`. Returning the bare { status, headers, body } instead leaves
  // the walk with no body at all, and the healthy-response test below then
  // passes for the wrong reason: nothing to check reports nothing either.
  const respondWith = (body: unknown) =>
    vi.mocked(executeNode).mockImplementation(async (_node: NodeDefinition) => ({
      output: { status: 200, headers: {}, body },
    }) as never)

  // The positive control first: a healthy response must produce NOTHING, or a
  // signal that fires on every run tells nobody anything (L159, L36).
  it('says nothing when the response carries everything it promised', async () => {
    respondWith({ lead_id: 'lead-1', reason: 'ineligible state', status: 'rejected' })

    const { result, flush } = run(LEAD_ECONOMY)
    await result
    await flush()

    expect(emitted(err, warn)).toEqual([])
  })

  // The incident, end to end through the real engine.
  it('reports a rejection sent without lead_id, naming the field and the trace', async () => {
    respondWith({ reason: 'ineligible state', status: 'rejected' })

    const { result, flush } = run(LEAD_ECONOMY)
    const res = await result
    await flush()

    const lines = emitted(err, warn)
    expect(lines.length).toBe(1)
    expect(lines[0].event).toBe(RESPONSE_CONTRACT_EVENTS.missing)
    expect(lines[0].missing_fields).toEqual(['lead_id'])
    // The trace id ties the signal back to the run, which is the whole point of
    // a countable signal rather than a bare warning.
    expect(lines[0].trace_id).toBe(res.traceId)
    expect(lines[0].execution_id).toBe(res.executionId)

    // And it did NOT block: the partner still got its rejection.
    expect(res.response).toEqual({ reason: 'ineligible state', status: 'rejected' })
    expect(res.status).toBe(200)
  })

  it('reports a workflow with no declared contract rather than passing it silently', async () => {
    respondWith({ anything: true })

    const { result, flush } = run('wf-nobody-declared')
    await result
    await flush()

    const lines = emitted(err, warn)
    expect(lines.length).toBe(1)
    expect(lines[0].event).toBe(RESPONSE_CONTRACT_EVENTS.undeclared)
  })

  // The branch that is easiest to forget, because it is assigned in the error
  // handler rather than from the walk: { error, trace_id } carries only OUR
  // identifier, so a partner receiving it cannot correlate it at all.
  it('judges the engine-error response too', async () => {
    vi.mocked(executeNode).mockRejectedValue(new Error('something escaped the walk'))

    const { result, flush } = run(LEAD_ECONOMY)
    await result
    await flush()

    const lines = emitted(err, warn)
    const contractLines = lines.filter((l) => l.event === RESPONSE_CONTRACT_EVENTS.unrecognised)
    expect(contractLines.length).toBe(1)
    expect(contractLines[0].keys).toEqual(['error', 'trace_id'])
  })
})
