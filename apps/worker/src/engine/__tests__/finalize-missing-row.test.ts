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

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { createExecutionRecord, updateExecutionRecord, flushStepLogs } from '../step-logger'
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
      moneyRuntime(supabase),
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
    slack_channel: null, lane: 'money',
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

  // #584: finalize must hand updateExecutionRecord the create fields so a missing
  // base row can be reconstructed instead of only dead-lettered. Without this
  // wiring the reconstruction path is unreachable in production.
  it('passes the create fields to finalize so a missing row can be reconstructed', async () => {
    vi.mocked(updateExecutionRecord).mockResolvedValue(null)

    const { harness, result } = run()
    await result
    await harness.flush()

    const createFields = vi.mocked(updateExecutionRecord).mock.calls[0][4]
    expect(createFields).toMatchObject({
      workflow_id: WF_ID,
      workflow_version_id: 'v1',
      source: 'engine',
      trigger_payload: { lead: 1 },
      is_test: false,
    })
  })

  // #629: after finalize reconstructs the missing base row, the step logs whose
  // flush was FK-blocked (it was chained on the createExecutionRecord insert,
  // which failed) must be re-flushed so the recovered run keeps its trace.
  it('re-flushes the lost step logs after the missing base row is reconstructed (#629)', async () => {
    // Permanent create failure => executionRecordPromise rejects => the original
    // flush is skipped entirely. The only flush that runs is the recovery one.
    vi.mocked(createExecutionRecord).mockRejectedValueOnce(
      new Error('workflow_executions insert failed: null value in column "workflow_id"')
    )
    vi.mocked(flushStepLogs).mockResolvedValue(null)
    vi.mocked(updateExecutionRecord).mockImplementation(async (_s, _id, _sa, _u, _cf, onReconstructed) => {
      onReconstructed?.()
      return null
    })

    const { harness, result } = run()
    const r = await result
    // The caller was still served; recovery happens after the response.
    expect(r.status).toBe(200)
    await harness.flush()

    expect(vi.mocked(flushStepLogs)).toHaveBeenCalledTimes(1)
  })

  // #688: a run fully rescued (base row reconstructed, step logs re-flushed OK)
  // must NOT be recorded as 'failed' with "Step logs failed to persist" (true of
  // the original FK-blocked flush, untrue by the time the record is written). It
  // is 'degraded' with a message describing the reconstruction.
  it('records a reconstructed, fully-recovered run as degraded, not failed (#688)', async () => {
    vi.mocked(createExecutionRecord).mockRejectedValueOnce(
      new Error('workflow_executions insert failed: null value in column "workflow_id"')
    )
    vi.mocked(flushStepLogs).mockResolvedValue(null) // the recovery re-flush succeeds
    vi.mocked(updateExecutionRecord).mockImplementation(async (_s, _id, _sa, _u, _cf, onReconstructed) => {
      onReconstructed?.()
      return null
    })

    const { harness, result } = run()
    const r = await result
    expect(r.status).toBe(200)
    await harness.flush()

    const statusWrites = vi.mocked(updateExecutionRecord).mock.calls
      .map((c) => c[3] as { status?: string; error_message?: string | null })
      .filter((u) => u.status !== undefined)
    const finalWrite = statusWrites.at(-1)!
    expect(finalWrite.status).toBe('degraded')
    // Not the stale, now-untrue persistence-failure wording.
    for (const u of statusWrites) {
      expect(u.status).not.toBe('failed')
      expect(u.error_message ?? '').not.toContain('Step logs failed to persist')
    }
    expect(finalWrite.error_message ?? '').toMatch(/reconstruct/i)
  })

  it('records a reconstructed run whose re-flush FAILED as failed (#688)', async () => {
    vi.mocked(createExecutionRecord).mockRejectedValueOnce(
      new Error('workflow_executions insert failed: null value in column "workflow_id"')
    )
    // The recovery re-flush itself fails: the step trace is genuinely lost.
    vi.mocked(flushStepLogs).mockResolvedValue('execution_steps insert failed: FK still unsatisfied')
    vi.mocked(updateExecutionRecord).mockImplementation(async (_s, _id, _sa, _u, _cf, onReconstructed) => {
      onReconstructed?.()
      return null
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    const statusWrites = vi.mocked(updateExecutionRecord).mock.calls
      .map((c) => c[3] as { status?: string; error_message?: string | null })
      .filter((u) => u.status !== undefined)
    const finalWrite = statusWrites.at(-1)!
    expect(finalWrite.status).toBe('failed')
    expect(finalWrite.error_message ?? '').toMatch(/reconstruct/i)
  })

  it('records a reconstructed run whose re-flush THREW as failed, not an escaped error (#688)', async () => {
    vi.mocked(createExecutionRecord).mockRejectedValueOnce(
      new Error('workflow_executions insert failed: null value in column "workflow_id"')
    )
    // The recovery re-flush throws rather than returning an error string.
    vi.mocked(flushStepLogs).mockRejectedValue(new Error('connection reset during re-flush'))
    vi.mocked(updateExecutionRecord).mockImplementation(async (_s, _id, _sa, _u, _cf, onReconstructed) => {
      onReconstructed?.()
      return null
    })

    const { harness, result } = run()
    // The throw must not escape the finalize; the caller is still served.
    const r = await result
    expect(r.status).toBe(200)
    await harness.flush()

    const statusWrites = vi.mocked(updateExecutionRecord).mock.calls
      .map((c) => c[3] as { status?: string; error_message?: string | null })
      .filter((u) => u.status !== undefined)
    expect(statusWrites.at(-1)!.status).toBe('failed')
    expect(statusWrites.at(-1)!.error_message ?? '').toMatch(/reconstruct/i)
  })

  it('does not re-flush when finalize did not reconstruct the row (#629)', async () => {
    // Clean finalize (row was present all along): the callback is never fired,
    // so no extra recovery flush runs on top of the normal one.
    vi.mocked(updateExecutionRecord).mockResolvedValue(null)
    vi.mocked(flushStepLogs).mockResolvedValue(null)

    const { harness, result } = run()
    await result
    await harness.flush()

    // Only the normal end-of-execution flush; no recovery re-flush.
    expect(vi.mocked(flushStepLogs)).toHaveBeenCalledTimes(1)
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
