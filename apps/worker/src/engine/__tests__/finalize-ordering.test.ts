/**
 * Issue #481: the finalize block was only ever tested through its extracted
 * helpers (computeSightingFinalize, finalizeSighting), never by driving the real
 * executeWorkflow finalize path. That left the #88 / #353 ordering invariant
 * unguarded: a regression could remove the await and every test would pass.
 *
 * The invariant, from engine/index.ts: finalize's winner UPDATE matches
 * lead_sighting_bids on execution_id + partner_slug. If it runs before a bid
 * insert commits, it matches zero rows and the winner stays is_winner=false
 * forever, silently falsifying a money outcome. So finalizeSighting must not be
 * called until every pending bid write has settled, whether that write was
 * registered during the walk (partner_bid / bid_group) or derived at finalize
 * time from a code node's output (#349).
 *
 * These tests drive executeWorkflow with a waitUntil collector and assert the
 * real ordering, not the helpers'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { ExecutionContext as EngineContext, WorkflowDefinition } from '../../types'

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
vi.mock('../bid-log', () => ({ deriveCodeNodeBidAttempts: vi.fn().mockReturnValue([]) }))
vi.mock('../lead-sightings', () => ({
  insertSighting: vi.fn().mockResolvedValue(undefined),
  upsertPerson: vi.fn().mockResolvedValue(null),
  extractSightingFields: vi.fn().mockReturnValue({}),
  extractPersonFields: vi.fn().mockReturnValue(null),
  computeSightingFinalize: vi.fn().mockReturnValue({}),
  buildSightingFinalizeProjection: vi.fn().mockReturnValue({}),
  finalizeSighting: vi.fn(),
  recordBidAttempt: vi.fn(),
}))

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { deriveCodeNodeBidAttempts } from '../bid-log'
import { finalizeSighting, recordBidAttempt } from '../lead-sightings'

const WF_ID = 'wf-481'

// trigger → one node. The node stands in for a partner_bid step.
const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: {} },
  nodes: [{ id: 'n', namespace: 'partner_a', type: 'salesforce', config: { retries: 0 } }],
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
  // Drain waitUntil repeatedly: the finalize chain registers further work.
  const flush = async () => {
    for (let i = 0; i < 6 && background.length; i++) {
      await Promise.all(background.splice(0))
    }
  }
  return { env, executionCtx, flush }
}

const supabase = {
  from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) }),
} as unknown as SupabaseClient

function loadDef(captureSightings: boolean) {
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Finalize Ordering',
    org_id: 'org-1',
    slack_channel: null,
    capture_sightings: captureSightings,
  })
}

async function run(opts: { isTest?: boolean } = {}) {
  const harness = makeHarness()
  await executeWorkflow(
    { workflowId: WF_ID, payload: { lead: 1 }, source: 'engine', ...opts },
    harness.env,
    supabase,
    harness.executionCtx,
  )
  await harness.flush()
}

// Records the real completion order of the writes we care about.
let order: string[] = []

/** A bid insert that takes real time to commit, like the Supabase round trip. */
function slowBidWrite(slug: string): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
    order.push(`bid:${slug}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  order = []
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } })
  vi.mocked(deriveCodeNodeBidAttempts).mockReturnValue([])
  vi.mocked(finalizeSighting).mockImplementation(async () => { order.push('finalize') })
  vi.mocked(recordBidAttempt).mockImplementation(((_c: unknown, bid: { partner_slug: string }) =>
    slowBidWrite(bid.partner_slug)) as never)
})

describe('finalize ordering against the real engine (#481)', () => {
  it('waits for a bid write registered during the walk before finalizing', async () => {
    loadDef(true)
    // Stand in for partner-bid.ts: the node registers its insert on ctx during the walk.
    vi.mocked(executeNode).mockImplementation(async (_node, ctx: EngineContext) => {
      const c = ctx as EngineContext & { pendingBidWrites?: Promise<unknown>[] }
      c.pendingBidWrites ??= []
      c.pendingBidWrites.push(slowBidWrite('tripoint'))
      return { output: { bid_cents: 5000 } }
    })

    await run()

    // The winner UPDATE inside finalizeSighting must never run before the insert
    // it needs to match. Remove the `await Promise.allSettled(...)` in
    // engine/index.ts and this flips to ['finalize', 'bid:tripoint'].
    expect(order).toEqual(['bid:tripoint', 'finalize'])
  })

  it('waits for bid writes derived at finalize time from a code node (#349)', async () => {
    loadDef(true)
    vi.mocked(deriveCodeNodeBidAttempts).mockReturnValue([
      { partner_slug: 'tripoint' },
      { partner_slug: 'm1' },
    ] as never)

    await run()

    expect(recordBidAttempt).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['bid:tripoint', 'bid:m1', 'finalize'])
  })

  it('waits for both the walk-registered and the finalize-derived writes together', async () => {
    loadDef(true)
    vi.mocked(executeNode).mockImplementation(async (_node, ctx: EngineContext) => {
      const c = ctx as EngineContext & { pendingBidWrites?: Promise<unknown>[] }
      c.pendingBidWrites ??= []
      c.pendingBidWrites.push(slowBidWrite('walk-partner'))
      return { output: { ok: true } }
    })
    vi.mocked(deriveCodeNodeBidAttempts).mockReturnValue([{ partner_slug: 'code-partner' }] as never)

    await run()

    expect(order[order.length - 1]).toBe('finalize')
    expect(order).toContain('bid:walk-partner')
    expect(order).toContain('bid:code-partner')
  })

  it('still finalizes exactly once when a bid write rejects (allSettled, not all)', async () => {
    loadDef(true)
    vi.mocked(deriveCodeNodeBidAttempts).mockReturnValue([{ partner_slug: 'tripoint' }] as never)
    vi.mocked(recordBidAttempt).mockRejectedValue(new Error('bids insert failed'))

    await run()

    // A lost bid row must not also cost us the sighting outcome.
    expect(finalizeSighting).toHaveBeenCalledTimes(1)
  })

  it('finalizes exactly once, never twice, on a clean run', async () => {
    loadDef(true)
    await run()
    expect(finalizeSighting).toHaveBeenCalledTimes(1)
  })

  it('does not finalize a test run (no sighting was inserted at the trigger boundary)', async () => {
    loadDef(true)
    await run({ isTest: true })
    expect(finalizeSighting).not.toHaveBeenCalled()
    expect(recordBidAttempt).not.toHaveBeenCalled()
  })

  it('does not finalize when the workflow has sighting capture turned off', async () => {
    loadDef(false)
    await run()
    expect(finalizeSighting).not.toHaveBeenCalled()
  })
})
