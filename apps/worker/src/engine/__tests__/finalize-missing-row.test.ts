/**
 * Missing execution row at finalize (issue #487, AUD-024).
 *
 * createExecutionRecord throws on a permanent insert failure, but the engine
 * chains it through flushPromise, whose .catch swallows the throw into a message
 * string. Finalize then runs anyway and UPDATEs a row that does not exist. The
 * lead was served a real HTTP response; the execution row, the step rows, and
 * anything the strand drain could recover are all gone.
 *
 * The finalize UPDATE now reports zero-rows-matched as an error, and the engine
 * dead-letters it through the existing rate-aggregated alert so a vanished lead
 * is visible instead of silently OK.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'
import { NO_ROW_MATCHED_CODE } from '../step-logger'
import { formatErr } from '../../lib/format-error'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../step-logger')>()
  return {
    NO_ROW_MATCHED_CODE: actual.NO_ROW_MATCHED_CODE,
    createExecutionRecord: vi.fn().mockResolvedValue(undefined),
    updateExecutionRecord: vi.fn().mockResolvedValue(null),
    flushStepLogs: vi.fn().mockResolvedValue(null),
  }
})
vi.mock('../nodes/index')
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../durability', () => ({ recordOutcomeDeadLetter: vi.fn().mockResolvedValue(true) }))

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { updateExecutionRecord } from '../step-logger'
import { recordOutcomeDeadLetter } from '../durability'

const WF_ID = 'wf-finalize'
const RESPONSE = { status: 200, headers: {}, body: { accepted: true } }

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'r', namespace: 'offer_response', type: 'response', config: { retries: 0 } }],
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
  const env = {
    IDEMPOTENCY: makeKV(),
    WORKFLOW_CACHE: makeKV(),
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
  } as unknown as Env
  const executionCtx = { waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})) }
  const flush = async () => {
    for (let i = 0; i < 6 && background.length; i++) {
      await Promise.all(background.splice(0))
    }
  }
  return { env, executionCtx, flush }
}

const supabase = {} as SupabaseClient

function run(options: Record<string, unknown> = {}) {
  const harness = makeHarness()
  return {
    harness,
    result: executeWorkflow(
      { workflowId: WF_ID, payload: { lead: 1 }, source: 'engine', ...options },
      harness.env,
      supabase,
      harness.executionCtx
    ),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Finalize Test',
    org_id: 'org-1',
    slack_channel: null,
    capture_sightings: false,
  })
  vi.mocked(executeNode).mockResolvedValue({ output: RESPONSE, earlyResponse: RESPONSE })
})

describe('finalize update failure (#487)', () => {
  it('dead-letters a missing execution row so a served lead does not vanish silently', async () => {
    vi.mocked(updateExecutionRecord).mockResolvedValue({
      code: NO_ROW_MATCHED_CODE,
      message: 'no workflow_executions row matched id=exec-1: the execution record is missing',
    })

    const { harness, result } = run()
    const r = await result
    // The caller was served. That is exactly why losing the row matters.
    expect(r.status).toBe(200)

    await harness.flush()

    // The cause is handed over as-is: recordOutcomeDeadLetter runs it through
    // formatErr, so the alert names the failure rather than "[object Object]".
    expect(vi.mocked(recordOutcomeDeadLetter)).toHaveBeenCalledWith(
      'execution_finalize',
      expect.anything(),
      expect.objectContaining({ orgId: 'org-1' })
    )
    const rendered = formatErr(vi.mocked(recordOutcomeDeadLetter).mock.calls[0][1])
    expect(rendered).not.toContain('[object Object]')
    expect(rendered).toContain(NO_ROW_MATCHED_CODE)
    expect(rendered).toContain('execution record is missing')
  })

  it('dead-letters a finalize update that exhausted its retries', async () => {
    vi.mocked(updateExecutionRecord).mockResolvedValue({ code: 'PGRST002', message: 'schema cache' })

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(vi.mocked(recordOutcomeDeadLetter)).toHaveBeenCalledWith(
      'execution_finalize',
      expect.anything(),
      expect.anything()
    )
    const rendered = formatErr(vi.mocked(recordOutcomeDeadLetter).mock.calls[0][1])
    expect(rendered).not.toContain('[object Object]')
    expect(rendered).toContain('PGRST002')
  })

  it('does not dead-letter a clean finalize', async () => {
    vi.mocked(updateExecutionRecord).mockResolvedValue(null)

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(vi.mocked(recordOutcomeDeadLetter)).not.toHaveBeenCalled()
  })

  it('does not dead-letter a test run', async () => {
    vi.mocked(updateExecutionRecord).mockResolvedValue({
      code: NO_ROW_MATCHED_CODE,
      message: 'no workflow_executions row matched id=exec-1: the execution record is missing',
    })

    const { harness, result } = run({ isTest: true })
    await result
    await harness.flush()

    expect(vi.mocked(recordOutcomeDeadLetter)).not.toHaveBeenCalled()
  })
})
