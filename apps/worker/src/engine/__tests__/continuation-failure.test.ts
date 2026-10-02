/**
 * Post-response (continue_after_response) failure surfacing — issue #51.
 *
 * When a Response node has continue_after_response:true, the response is sent
 * to the caller early and the walk keeps running post-response steps in the
 * background (the "Offer Response then patch Salesforce" pattern). The lead was
 * served correctly, so a failure in one of those post-response steps must NOT
 * hard-fail/per-run-page the execution (#310 / the 2026-06-15 false-page class).
 * These tests guard that:
 *   - the caller still gets the early (successful) response,
 *   - the execution is recorded 'degraded' (visible, served-but-side-effect-failed),
 *     NOT 'failed', and the per-run failure alert does NOT fire (a writeback
 *     failure dead-letters via a rate-aggregated alert instead).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition, NodeDefinition } from '../../types'
import { PartnerApiError } from '../partner-bid-error'

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
import { updateExecutionRecord } from '../step-logger'
import { fireExecutionAlert } from '../../lib/execution-alerts'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = 'wf-continuation'
const EARLY_RESPONSE = { status: 200, headers: {}, body: { accepted: true, offer: 50 } }

// trigger → offer_response (continue_after_response) → patch_sf
const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [
    { id: 'r', namespace: 'offer_response', type: 'response', config: { continue_after_response: true, retries: 0 } },
    { id: 'p', namespace: 'patch_sf', type: 'salesforce', config: { retries: 0 } },
  ],
  edges: [{ id: 'e0', source: 'r', target: 'p' }],
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
  // Drain across iterations — the finalize closure schedules the alert in a
  // nested waitUntil, so newly-added promises must be awaited too.
  const flush = async () => {
    for (let i = 0; i < 6 && background.length; i++) {
      await Promise.all(background.splice(0))
    }
  }
  return { env, executionCtx, flush }
}

const supabase = {} as SupabaseClient

function run() {
  const harness = makeHarness()
  return {
    harness,
    result: executeWorkflow(
      { workflowId: WF_ID, payload: { lead: 1 }, source: 'engine' },
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
    workflow_name: 'Continuation Test',
    org_id: 'org-1',
    slack_channel: null, lane: 'money',
  })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('post-response step failure', () => {
  it('records degraded (not failed) without per-run paging, while the caller still gets the early response', async () => {
    vi.mocked(executeNode).mockImplementation(async (node: NodeDefinition) => {
      if (node.type === 'response') {
        return { output: EARLY_RESPONSE, earlyResponse: EARLY_RESPONSE, continueAfterResponse: true }
      }
      throw new Error('Salesforce patch failed: 400')
    })

    const { harness, result } = run()
    const r = await result

    // Caller got the early, successful response — unaffected by the post-response failure.
    expect(r.status).toBe(200)
    expect(r.response).toEqual(EARLY_RESPONSE.body)

    await harness.flush()

    // Served correctly, so the run is DEGRADED, not failed — the writeback detail
    // is recorded and the served status (200) is preserved.
    const updateCalls = vi.mocked(updateExecutionRecord).mock.calls
    const lastUpdate = updateCalls[updateCalls.length - 1][3] as Record<string, unknown>
    expect(lastUpdate.status).toBe('degraded')
    expect(lastUpdate.outcome).not.toBe('failed')
    expect(String(lastUpdate.error_message)).toContain('Salesforce patch failed')
    expect(lastUpdate.response_status).toBe(200)
    // The failed step's node type is recorded for upstream-outage attribution (#332).
    expect(lastUpdate.failed_step_type).toBe('salesforce')

    // No per-run failure alert — the writeback failure dead-letters separately.
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })

  it('a successful continuation stays completed with no alert', async () => {
    vi.mocked(executeNode).mockImplementation(async (node: NodeDefinition) => {
      if (node.type === 'response') {
        return { output: EARLY_RESPONSE, earlyResponse: EARLY_RESPONSE, continueAfterResponse: true }
      }
      return { output: { patched: true } }
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    const updateCalls = vi.mocked(updateExecutionRecord).mock.calls
    const lastUpdate = updateCalls[updateCalls.length - 1][3] as Record<string, unknown>
    expect(lastUpdate.status).toBe('completed')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })

  it('a suppressed / business-rejection continuation records degraded but does not alert', async () => {
    vi.mocked(executeNode).mockImplementation(async (node: NodeDefinition) => {
      if (node.type === 'response') {
        return { output: EARLY_RESPONSE, earlyResponse: EARLY_RESPONSE, continueAfterResponse: true }
      }
      // errorType null + suppressAlert true → mirrors a business rejection.
      throw new PartnerApiError('downstream declined', null, true)
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    const updateCalls = vi.mocked(updateExecutionRecord).mock.calls
    const lastUpdate = updateCalls[updateCalls.length - 1][3] as Record<string, unknown>
    expect(lastUpdate.status).toBe('degraded')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })
})
