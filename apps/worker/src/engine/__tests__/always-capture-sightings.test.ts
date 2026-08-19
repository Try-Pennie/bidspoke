/**
 * Every workflow records a lead sighting. There is no opt out (#882).
 *
 * `workflows.capture_sightings` defaulted to true but could be switched off per
 * workflow. It was false on Main Flow, the live flow carrying the Equifax credit
 * report, which ran 10,831 executions in three days. Those leads produced no
 * sighting, nothing in Snowflake, and their execution truncates at 7 days, so
 * roughly 3,600 leads a day left no durable record anywhere.
 *
 * There was no audit trail of the switch ever changing, despite the handler
 * writing that field into audit_log since the feature shipped, so it was set
 * directly in the database and who, when and why are unrecoverable.
 *
 * The column still exists (expand now, contract later per ADR 0007), but the
 * opt-out is no longer REPRESENTABLE: the field is gone from LoadedWorkflow, so
 * no caller can express it and no test can construct it. That is stronger than
 * a test asserting a false flag is ignored, which is why no such test appears
 * here. What still needs guarding is the column being READ again, and
 * capture-sightings-unwritable.test.ts does that against the whole worker tree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', () => ({
  NO_ROW_MATCHED_CODE: 'BIDSPOKE_NO_ROW_MATCHED',
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(null),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../durability', () => ({ recordOutcomeDeadLetter: vi.fn().mockResolvedValue(true) }))
vi.mock('../lead-sightings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lead-sightings')>()),
  insertSighting: vi.fn().mockResolvedValue(undefined),
  finalizeSighting: vi.fn().mockResolvedValue(undefined),
}))

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { insertSighting } from '../lead-sightings'

const RESPONSE = { status: 200, headers: {}, body: { ok: true } }
const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'resp', type: 'response', config: { retries: 0 } }],
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

function makeHarness() {
  const background: Promise<unknown>[] = []
  const env = { IDEMPOTENCY: makeKV(), WORKFLOW_CACHE: makeKV(), APP_URL: 'https://app.test', PII_REDACTION_FIELDS: '' } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }
  const drain = async () => {
    for (let i = 0; i < 8 && background.length; i++) await Promise.all(background.splice(0))
  }
  return { env, executionCtx, drain }
}

const supabase = {} as SupabaseClient

function loadDefinition() {
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Main Flow',
    org_id: 'org-1',
    slack_channel: null,
  } as unknown as Awaited<ReturnType<typeof loadWorkflowDefinition>>)
}

async function run(isTest = false) {
  const { env, executionCtx, drain } = makeHarness()
  await executeWorkflow(
    { workflowId: 'wf-1', payload: { ssn: '000-00-0000' }, source: 'engine', isTest },
    env,
    supabase,
    executionCtx,
  )
  await drain()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeNode).mockResolvedValue({ output: RESPONSE, earlyResponse: RESPONSE })
})

describe('lead sighting capture', () => {
  it('records a sighting for a live run, with nothing able to opt the workflow out', async () => {
    loadDefinition()

    await run()

    expect(insertSighting).toHaveBeenCalledTimes(1)
  })

  it('does not record for a test run, which is the only remaining exclusion', async () => {
    loadDefinition()

    await run(true)

    expect(insertSighting).not.toHaveBeenCalled()
  })
})
