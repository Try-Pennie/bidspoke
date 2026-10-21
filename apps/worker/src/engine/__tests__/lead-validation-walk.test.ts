/**
 * The lead validation node through a whole run (#2589): a rejection answers the
 * lead source as the validate script's sentinel did and ends the walk; a
 * missing setting fails the run with its per run page suppressed and is handed
 * to the once per incident reporter; a check set to fail the run pages as any
 * failure does. Real executors; only the database, Slack and the reporter are
 * stood in for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../test-setup/wait-until'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({
  loadPartnerConstants: vi.fn().mockResolvedValue({ sellOff: {}, clickUrls: {}, subAccountIdsMap: {}, activeBidding: {} }),
}))
vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/lead-validation-config-alert', () => ({ reportLeadValidationEvent: vi.fn().mockResolvedValue('nothing_due') }))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { updateExecutionRecord } from '../step-logger'
import { fireExecutionAlert } from '../../lib/execution-alerts'
import { reportLeadValidationEvent } from '../../lib/lead-validation-config-alert'

const WF_ID = '0b6f6c1e-2a43-4c35-9a9e-3d1c55b7a001'

const amountCheck = (on_missing: string) => ({
  id: 'amount',
  label: 'Loan amount',
  condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.loanAmount', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' }] }] },
  reason: 'loan amount exceeds maximum',
  on_missing,
})

function definition(data: Record<string, unknown>, on_missing = 'reject'): WorkflowDefinition {
  return {
    trigger: { id: 'trigger', type: 'trigger', config: {} },
    nodes: [
      { id: 'c', namespace: 'constants', type: 'constants', config: { data } },
      {
        id: 'v',
        namespace: 'validate_bidding_and_state',
        type: 'lead_validation',
        config: {
          lead_id_field: 'trigger.payload.leadUuid',
          checks: [
            {
              id: 'state',
              label: 'State',
              condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.state', operator: 'in_array', value: 'steps.constants.output.states' }] }] },
              reason: 'ineligible state',
              on_missing: 'reject',
            },
            amountCheck(on_missing),
          ],
          response_headers: { 'Content-Type': 'application/json' },
          retries: 2,
        },
      },
      { id: 'r', namespace: 'answer', type: 'response', config: { status_code: 200, body: { status: 'accepted' } } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'c' },
      { id: 'e1', source: 'c', target: 'v' },
      { id: 'e2', source: 'v', target: 'r' },
    ],
  } as unknown as WorkflowDefinition
}

const CONSTANTS = { states: ['TX', 'FL'], maximumLoanAmount: 50000 }

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = store.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

const supabase = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) }) } as unknown as SupabaseClient

async function run(def: WorkflowDefinition, payload: Record<string, unknown>) {
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition: def,
    workflow_version_id: 'v1',
    workflow_name: 'RML - Bidding Workflow (GigFi)',
    org_id: 'org-1',
    slack_channel: '#rml',
    lane: 'money',
  })
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  const executionCtx = recordingContext()
  const result = await executeWorkflow({ workflowId: WF_ID, payload, source: 'gigfi' }, env, moneyRuntime(supabase), executionCtx)
  await executionCtx.settle()
  return result
}

function lastUpdate() {
  const calls = vi.mocked(updateExecutionRecord).mock.calls
  return calls[calls.length - 1][3] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lead validation in a run', () => {
  it('control: a lead passing every check reaches the next step', async () => {
    const result = await run(definition(CONSTANTS), { leadUuid: 'l-1', state: 'TX', loanAmount: 1000 })
    expect(result.status).toBe(200)
    expect(result.response).toEqual({ status: 'accepted' })
    expect(lastUpdate().status).toBe('completed')
    expect(vi.mocked(reportLeadValidationEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reportLeadValidationEvent).mock.calls[0][2]).toEqual({ kind: 'evaluated', namespace: 'validate_bidding_and_state' })
  })

  it('a rejection answers 200 with the configured headers and { lead_id, status, reason }, and nothing after it runs', async () => {
    const result = await run(definition(CONSTANTS), { leadUuid: 'l-1', state: 'NY', loanAmount: 1000 })
    expect(result.status).toBe(200)
    expect(result.response).toEqual({ lead_id: 'l-1', status: 'rejected', reason: 'ineligible state' })
    expect(result.responseHeaders).toEqual({ 'Content-Type': 'application/json' })
    expect(lastUpdate().status).toBe('completed')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })

  it('a missing setting fails the run, pages nothing per lead, and is handed to the incident reporter once', async () => {
    const result = await run(definition({ states: ['TX'] }), { leadUuid: 'l-1', state: 'TX', loanAmount: 1000 })
    expect(result.status).toBe(500)
    const update = lastUpdate()
    expect(update.status).toBe('failed')
    expect(String(update.error_message)).toContain('Lead validation setting missing: check amount reads steps.constants.output.maximumLoanAmount, which is missing')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
    // Not retried, whatever the node's retries say: one report per run.
    expect(vi.mocked(reportLeadValidationEvent)).toHaveBeenCalledTimes(1)
    const [deps, runInfo, event] = vi.mocked(reportLeadValidationEvent).mock.calls[0]
    expect(event).toEqual({
      kind: 'config_fault',
      namespace: 'validate_bidding_and_state',
      faults: [{ check_id: 'amount', reference: 'steps.constants.output.maximumLoanAmount', problem: 'missing' }],
    })
    expect(runInfo).toEqual({ orgId: 'org-1', workflowId: WF_ID, workflowName: 'RML - Bidding Workflow (GigFi)', slackChannel: '#rml' })
    expect(deps.silent).toBe(false)
  })

  it('a check set to fail the run fails it and pages as any failure does', async () => {
    const result = await run(definition(CONSTANTS, 'fail_run'), { leadUuid: 'l-1', state: 'TX' })
    expect(result.status).toBe(500)
    expect(lastUpdate().status).toBe('failed')
    expect(vi.mocked(fireExecutionAlert)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fireExecutionAlert).mock.calls[0][0]).toMatchObject({
      failedStep: 'validate_bidding_and_state',
      errorType: 'permanent',
      errorMessage: 'Lead validation check amount could not be judged: trigger.payload.loanAmount is missing',
    })
  })

  it('a test run hands the reporter its silence', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition: definition({ states: ['TX'] }), workflow_version_id: 'v1', workflow_name: 'W', org_id: 'org-1', slack_channel: null, lane: 'money',
    })
    const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
    const executionCtx = recordingContext()
    await executeWorkflow({ workflowId: WF_ID, payload: { state: 'TX', loanAmount: 1 }, source: 'gigfi', isTest: true }, env, moneyRuntime(supabase), executionCtx)
    await executionCtx.settle()
    expect(vi.mocked(reportLeadValidationEvent).mock.calls[0][0].silent).toBe(true)
  })
})
