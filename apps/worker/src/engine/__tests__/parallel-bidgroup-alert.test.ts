/**
 * Issue #64: a parallel-node failure or a bid_group execution error never fired
 * the failure Slack alert.
 *
 * The execution-level alert gate only fires when `failedErrorType !== null` — a
 * null type is read as a clean business rejection and stays deliberately silent.
 * Both the parallel block and the bid_group block recorded/threw their failure
 * with `errorType = null`, so an operational failure (a child rejected, the
 * group timed out, the bid executor threw) was promoted to a failed execution
 * but produced NO alert. These tests guard that both blocks now classify the
 * error (falling back to 'transient'), so the failure alert fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

vi.mock('../definition-loader')
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({ loadPartnerConstants: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/index')
vi.mock('../nodes/bid-group', () => ({ executeBidGroupNode: vi.fn() }))
vi.mock('../achieve-log', () => ({
  extractAchieveEvaluations: vi.fn().mockReturnValue([]),
  insertAchieveEvaluations: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/execution-alerts', () => ({ fireExecutionAlert: vi.fn().mockResolvedValue(undefined) }))

import { executeWorkflow } from '../index'
import { PartnerApiError } from '../partner-bid-error'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { executeBidGroupNode } from '../nodes/bid-group'
import { updateExecutionRecord, flushStepLogs } from '../step-logger'
import type { StepLogEntry } from '../step-logger'
import { fireExecutionAlert } from '../../lib/execution-alerts'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = 'wf-64'

// trigger → parallel(bid_parallel) --child-0--> child(partner_a)
const parallelDefinition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [
    { id: 'p', namespace: 'bid_parallel', type: 'parallel', config: { wait_for: 'all', on_child_error: 'fail', timeout_ms: 15000 } },
    { id: 'c', namespace: 'partner_a', type: 'salesforce', config: { retries: 0 } },
  ],
  edges: [{ id: 'e0', source: 'p', target: 'c', source_handle: 'child-0' }],
} as unknown as WorkflowDefinition

// trigger → single node, with a muted failure signal configured (#248)
const mutedSignalDefinition = {
  trigger: {
    id: 'trigger',
    type: 'trigger',
    config: { muted_failure_signals: [{ match: 'ACRO_GATEWAY', count: 10, window_minutes: 5 }] },
  },
  nodes: [{ id: 'n', namespace: 'equifax', type: 'salesforce', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

// trigger → bid_group(bid_race)
const bidGroupDefinition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [
    { id: 'g', namespace: 'bid_race', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: [] } },
  ],
  edges: [],
} as unknown as WorkflowDefinition

// #485: trigger → validate → (edge carrying an operator the evaluator doesn't
// know) → route. Edge evaluation runs OUTSIDE the per-node try/catch that wraps
// executor errors in a classified StepFailureError, so this surfaces as a raw
// Error thrown straight out of the walk. That is the class of failure a bad
// workflow edit produces, and the one the alert gate used to read as a clean
// business rejection.
const unknownOperatorDefinition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [
    { id: 'a', namespace: 'validate', type: 'salesforce', config: { retries: 0 } },
    { id: 'b', namespace: 'route', type: 'salesforce', config: { retries: 0 } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    {
      id: 'e1',
      source: 'a',
      target: 'b',
      condition: {
        logic: 'AND',
        groups: [
          { logic: 'AND', conditions: [{ field: 'trigger.body.lead', operator: 'not_a_real_operator', value: 1 }] },
        ],
      },
    },
  ],
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

// partner_configs lookups in the bid_group block must not blow up — return empty.
const supabase = {
  from: () => ({
    select: () => ({ in: () => Promise.resolve({ data: [] }) }),
  }),
} as unknown as SupabaseClient

function run() {
  const harness = makeHarness()
  return {
    harness,
    result: executeWorkflow(
      { workflowId: WF_ID, payload: { lead: 1 }, source: 'engine' },
      harness.env,
      supabase,
      harness.executionCtx
    ),
  }
}

function lastUpdate() {
  const calls = vi.mocked(updateExecutionRecord).mock.calls
  return calls[calls.length - 1][3] as Record<string, unknown>
}

// The step row the engine actually flushed for a given namespace. flushStepLogs
// receives the accumulated queue as its second argument.
function childStepRow(namespace: string): StepLogEntry {
  const calls = vi.mocked(flushStepLogs).mock.calls
  const queue = calls[calls.length - 1][1]
  const row = queue.find((r) => r.step_namespace === namespace)
  if (!row) throw new Error(`no step row logged for "${namespace}"`)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
})

function loadDef(definition: WorkflowDefinition) {
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Alert Test',
    org_id: 'org-1',
    slack_channel: null,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parallel-node failure fires the failure alert (#64)', () => {
  it('classifies the failure (non-null type) so the alert fires', async () => {
    loadDef(parallelDefinition)
    vi.mocked(executeNode).mockImplementation(async () => {
      throw new Error('Salesforce child failed: 500')
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    // Execution promoted to failed, blaming the parallel node.
    const update = lastUpdate()
    expect(update.status).toBe('failed')
    expect(String(update.error_message)).toContain('Parallel failed')

    // Failure alert fired for the parallel node.
    expect(vi.mocked(fireExecutionAlert)).toHaveBeenCalledTimes(1)
    const alert = vi.mocked(fireExecutionAlert).mock.calls[0][0]
    expect(alert.alertType).toBe('failure')
    expect(alert.failedStep).toBe('bid_parallel')
    expect(alert.errorType).not.toBeNull()
  })
})

describe('a parallel child keeps its partner classification (#486)', () => {
  // The child catch used to re-derive the type with a Response-or-transport
  // ternary that never checked PartnerApiError, so a partner's authoritative
  // classification (and its suppressAlert flag) was replaced with 'transient'.
  // The same partner failure in the main loop is classified correctly, so the
  // two paths disagreed purely on where the node happened to sit.

  it('records the partner error type on the child step row, not transient', async () => {
    loadDef(parallelDefinition)
    vi.mocked(executeNode).mockRejectedValue(
      new PartnerApiError('Partner 400: malformed lead', 'permanent', false)
    )

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(childStepRow('partner_a').error_type).toBe('permanent')
  })

  it('stays silent for a partner business rejection, exactly as the main loop does', async () => {
    // errorType null is the engine's business rejection: the partner looked at
    // the lead and declined it. Not an incident, so it must not page.
    loadDef(parallelDefinition)
    vi.mocked(executeNode).mockRejectedValue(
      new PartnerApiError('Partner declined: outside buy box', null, false)
    )

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(lastUpdate().status).toBe('failed')
    expect(childStepRow('partner_a').error_type).toBeNull()
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })

  it('honors suppressAlert on a partner error that is otherwise a real failure', async () => {
    // A classified failure the partner config asked us not to page on. The type
    // still records as permanent, but the alert stays suppressed.
    loadDef(parallelDefinition)
    vi.mocked(executeNode).mockRejectedValue(
      new PartnerApiError('Partner 403: not enabled for this vertical', 'permanent', true)
    )

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(lastUpdate().status).toBe('failed')
    expect(childStepRow('partner_a').error_type).toBe('permanent')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })
})

describe('muted failure signal suppresses the per-run alert (#248)', () => {
  it('records the run failed but does NOT page when the error matches a muted signal', async () => {
    loadDef(mutedSignalDefinition)
    vi.mocked(executeNode).mockImplementation(async () => {
      throw new Error('Service Exception... contact Equifax (ACRO_GATEWAY HTTP 500)')
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    // Status is unchanged — the run still records as failed (no credit pull).
    expect(lastUpdate().status).toBe('failed')
    // But the per-execution page is muted for the matched signal.
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })

  it('still pages when the failure is neither a muted signal nor a shared-upstream outage', async () => {
    loadDef(mutedSignalDefinition)
    // A genuine per-lead error — not a muted signal and not a recognized
    // shared-upstream outage (#331), so the per-run page must still fire.
    vi.mocked(executeNode).mockImplementation(async () => {
      throw new Error('Unexpected null in lead payload mapping')
    })

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(lastUpdate().status).toBe('failed')
    expect(vi.mocked(fireExecutionAlert)).toHaveBeenCalledTimes(1)
  })
})

describe('raw walk exceptions fire the failure alert (#485)', () => {
  it('classifies an unknown-operator edge failure as permanent so the alert fires', async () => {
    loadDef(unknownOperatorDefinition)
    vi.mocked(executeNode).mockResolvedValue({ ok: true } as never)

    const { harness, result } = run()
    await result
    await harness.flush()

    const update = lastUpdate()
    expect(update.status).toBe('failed')
    expect(String(update.error_message)).toContain('Unknown condition operator')

    // A raw (non-StepFailureError) walk exception is an operational failure, not
    // a business rejection, so it must carry a type for the alert gate to open.
    expect(vi.mocked(fireExecutionAlert)).toHaveBeenCalledTimes(1)
    const alert = vi.mocked(fireExecutionAlert).mock.calls[0][0]
    expect(alert.alertType).toBe('failure')
    expect(alert.errorType).toBe('permanent')
  })

  it('still stays silent for a business rejection (a null-type executor failure)', async () => {
    // Guard the other side of the gate: an executor failure the classifier calls
    // a business rejection (errorType null) keeps its deliberate silence. Only
    // the raw-exception path is promoted, not every null type.
    loadDef(mutedSignalDefinition)
    vi.mocked(executeNode).mockRejectedValue(new PartnerApiError('Lead rejected: not a fit', null, false))

    const { harness, result } = run()
    await result
    await harness.flush()

    expect(lastUpdate().status).toBe('failed')
    expect(vi.mocked(fireExecutionAlert)).not.toHaveBeenCalled()
  })
})

describe('bid_group execution error fires the failure alert (#64)', () => {
  it('classifies the failure (non-null type) so the alert fires', async () => {
    loadDef(bidGroupDefinition)
    vi.mocked(executeBidGroupNode).mockRejectedValue(new Error('bid group exploded'))

    const { harness, result } = run()
    await result
    await harness.flush()

    const update = lastUpdate()
    expect(update.status).toBe('failed')
    expect(String(update.error_message)).toContain('bid group exploded')

    expect(vi.mocked(fireExecutionAlert)).toHaveBeenCalledTimes(1)
    const alert = vi.mocked(fireExecutionAlert).mock.calls[0][0]
    expect(alert.alertType).toBe('failure')
    expect(alert.failedStep).toBe('bid_race')
    expect(alert.errorType).not.toBeNull()
  })
})
