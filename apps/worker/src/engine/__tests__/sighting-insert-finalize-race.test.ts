/**
 * The sighting insert must land before finalize updates it.
 *
 * insertSighting is fired into waitUntil at the trigger boundary. Nothing awaited
 * it, so on the fast engine-bidding path finalizeSighting regularly ran first and
 * its UPDATE matched a row that did not exist yet. (At the time the insert also
 * sat behind an awaited persons upsert, removed in #765.)
 *
 * Before the zero-row sweep (#583) that UPDATE silently did nothing and the
 * sighting sat at 'in_flight' until the strand drain repaired it. After the
 * sweep it reported an error, which made finalizeSighting return early and skip
 * the winner mark, and dead-lettered. Measured at ~18% of live leads.
 *
 * Both writes already run after the HTTP response is sent, so awaiting the
 * insert costs the caller nothing and removes the race outright.
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
// Partial mock: keep every real export (buildSightingFinalizeProjection etc.)
// and override only the two writes whose ordering is under test.
vi.mock('../lead-sightings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lead-sightings')>()),
  insertSighting: vi.fn(),
  finalizeSighting: vi.fn().mockResolvedValue(undefined),
}))

import { executeWorkflow, moneyRuntime } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { insertSighting, finalizeSighting } from '../lead-sightings'

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
  // Advance the microtask/macrotask queue WITHOUT awaiting the background
  // promises: one of them is deliberately left pending to model an insert that
  // has not landed. Awaiting it would just hang the test.
  const settle = async (ticks = 12) => {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const drain = async () => {
    for (let i = 0; i < 8 && background.length; i++) await Promise.all(background.splice(0))
  }
  return { env, executionCtx, settle, drain }
}

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Race Test',
    org_id: 'org-1',
    slack_channel: null, lane: 'money',
  })
  vi.mocked(executeNode).mockResolvedValue({ output: RESPONSE, earlyResponse: RESPONSE })
})

describe('sighting insert / finalize ordering', () => {
  it('does not finalize a sighting before its insert has landed', async () => {
    const order: string[] = []
    let releaseInsert!: () => void
    const insertLanded = new Promise<void>((r) => { releaseInsert = r })

    vi.mocked(insertSighting).mockImplementation(async () => {
      await insertLanded
      order.push('insert')
      return null
    })
    vi.mocked(finalizeSighting).mockImplementation(async () => { order.push('finalize') })

    const harness = makeHarness()
    await executeWorkflow({ workflowId: 'wf-1', payload: { lead: 1 }, source: 'engine' }, harness.env, moneyRuntime(supabase), harness.executionCtx)

    // Let every already-resolvable background task run. If finalize does not
    // await the insert, it runs here, while the insert is still pending.
    await harness.settle()
    expect(order).not.toContain('finalize')

    releaseInsert()
    await harness.drain()

    expect(order).toEqual(['insert', 'finalize'])
  })

  it('still finalizes when the sighting insert fails, so a lost insert does not also lose the finalize', async () => {
    const order: string[] = []
    vi.mocked(insertSighting).mockRejectedValue(new Error('insert failed'))
    vi.mocked(finalizeSighting).mockImplementation(async () => { order.push('finalize') })

    const harness = makeHarness()
    await executeWorkflow({ workflowId: 'wf-1', payload: { lead: 1 }, source: 'engine' }, harness.env, moneyRuntime(supabase), harness.executionCtx)
    await harness.drain()

    expect(order).toEqual(['finalize'])
  })

  it('returns the caller response without waiting on the sighting insert', async () => {
    let releaseInsert!: () => void
    const insertLanded = new Promise<void>((r) => { releaseInsert = r })
    vi.mocked(insertSighting).mockImplementation(() => insertLanded.then(() => null))

    const harness = makeHarness()
    // Would hang if the response path awaited the insert.
    const result = await executeWorkflow({ workflowId: 'wf-1', payload: { lead: 1 }, source: 'engine' }, harness.env, moneyRuntime(supabase), harness.executionCtx)
    expect(result.status).toBe(200)

    releaseInsert()
    await harness.drain()
  })
})
