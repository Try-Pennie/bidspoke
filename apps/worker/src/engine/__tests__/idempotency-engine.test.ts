/**
 * Idempotency behavior of executeWorkflow (issue #49).
 *
 * Regression guards for three compounding bugs:
 *  1. Failed executions were cached as the idempotent result, so the source's
 *     retry got the stale error back instead of a re-execution.
 *  2. Replays hardcoded HTTP 200 with no headers, so a cached 4xx (or any
 *     custom headers) replayed with a different wire contract — and a cached
 *     failure replayed as "success", stopping upstream retries for good.
 *  3. Resume/replay hit the cache like any duplicate, so the operator's
 *     recovery action returned the cached entry without executing anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { IdempotencyState, WorkflowDefinition } from '../../types'

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

import { executeWorkflow } from '../index'
import { loadWorkflowDefinition } from '../definition-loader'
import { executeNode } from '../nodes/index'
import { deriveIdempotencyKey } from '../../lib/crypto'

// ── In-memory KV mock ─────────────────────────────────────────────────────────

function makeKV() {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string, type?: string) {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = 'wf-idem'
const PAYLOAD = { email: 'lead@example.com', amount: 25000 }

const definition = {
  trigger: {
    id: 'trigger',
    type: 'trigger',
    config: {
      idempotency: { enabled: true, derive_from_fields: ['email'], ttl_seconds: 300 },
    },
  },
  nodes: [
    { id: 'a', namespace: 'step_a', type: 'code', config: { retries: 0 } },
    { id: 'b', namespace: 'send_response', type: 'response', config: { retries: 0 } },
  ],
  edges: [{ id: 'e0', source: 'a', target: 'b' }],
} as unknown as WorkflowDefinition

const RESPONSE_HEADERS = { 'x-submission-id': 'sub-1' }

function mockNodesSucceed(status = 200) {
  vi.mocked(executeNode).mockImplementation(async (node) => {
    if ((node as { type: string }).type === 'response') {
      return { output: { status, headers: RESPONSE_HEADERS, body: { decision: 'ok' } } }
    }
    return { output: { worked: true } }
  })
}

function mockNodesFail() {
  vi.mocked(executeNode).mockRejectedValue(new Error('partner exploded'))
}

// ── Harness ───────────────────────────────────────────────────────────────────

function makeHarness() {
  const { kv, store } = makeKV()
  const env = {
    IDEMPOTENCY: kv,
    WORKFLOW_CACHE: makeKV().kv,
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
  } as unknown as Env
  const background: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})),
  }
  const flush = () => Promise.all(background)
  return { env, store, executionCtx, flush }
}

// Resume preloads prior steps from Supabase; everything else in these tests
// goes through mocked modules, so a minimal chainable stub suffices.
const supabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  }),
} as unknown as SupabaseClient

async function kvEntry(store: Map<string, string>): Promise<IdempotencyState | null> {
  const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
  const raw = store.get(`idempotent-${WF_ID}-${key}`)
  return raw ? (JSON.parse(raw) as IdempotencyState) : null
}

function run(extra: Partial<Parameters<typeof executeWorkflow>[0]> = {}, harness = makeHarness()) {
  return {
    harness,
    result: executeWorkflow(
      { workflowId: WF_ID, payload: PAYLOAD, source: 'test-source', ...extra },
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
    workflow_name: 'Idem Test',
    org_id: 'org-1',
    slack_channel: null,
    capture_sightings: false,
  })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('completed executions', () => {
  it('caches the result with the real status and headers', async () => {
    mockNodesSucceed(422)
    const { harness, result } = run()
    const r = await result
    await harness.flush()

    expect(r.status).toBe(422)
    const entry = await kvEntry(harness.store)
    expect(entry?.status).toBe('complete')
    expect(entry?.responseStatus).toBe(422)
    expect(entry?.responseHeaders).toEqual(RESPONSE_HEADERS)
  })

  it('duplicate replays the original status and headers, not a bare 200', async () => {
    mockNodesSucceed(422)
    const harness = makeHarness()
    await run({}, harness).result
    await harness.flush()

    vi.mocked(executeNode).mockClear()
    const replay = await run({}, harness).result
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.status).toBe(422)
    expect(replay.responseHeaders).toEqual(RESPONSE_HEADERS)
    expect(vi.mocked(executeNode)).not.toHaveBeenCalled()
  })

  it('legacy cache entries without a stored status replay as 200', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    harness.store.set(
      `idempotent-${WF_ID}-${key}`,
      JSON.stringify({ status: 'complete', response: { ok: true } })
    )

    const r = await run({}, harness).result
    expect(r.idempotentReplay).toBe(true)
    expect(r.status).toBe(200)
    expect(r.response).toEqual({ ok: true })
  })

  it('in-flight duplicate still gets 409', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    harness.store.set(`idempotent-${WF_ID}-${key}`, JSON.stringify({ status: 'processing' }))

    const r = await run({}, harness).result
    expect(r.status).toBe(409)
  })
})

describe('failed executions', () => {
  it('does not cache the failure and clears the processing marker', async () => {
    mockNodesFail()
    const { harness, result } = run()
    const r = await result
    await harness.flush()

    expect(r.status).toBe(500)
    expect(await kvEntry(harness.store)).toBeNull()
  })

  it('a retry after a failure re-executes instead of replaying the error', async () => {
    mockNodesFail()
    const harness = makeHarness()
    await run({}, harness).result
    await harness.flush()

    mockNodesSucceed()
    const retry = await run({}, harness).result
    await harness.flush()

    expect(retry.idempotentReplay).toBeUndefined()
    expect(retry.status).toBe(200)
    expect((await kvEntry(harness.store))?.status).toBe('complete')
  })
})

describe('resume and replay (recovery runs)', () => {
  it('replay executes even when a completed entry is cached', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    harness.store.set(
      `idempotent-${WF_ID}-${key}`,
      JSON.stringify({ status: 'complete', response: { stale: true } })
    )

    const r = await run({ parentExecutionId: 'orig-1' }, harness).result
    expect(r.idempotentReplay).toBeUndefined()
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
  })

  it('resume executes even when a processing entry is cached', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    harness.store.set(`idempotent-${WF_ID}-${key}`, JSON.stringify({ status: 'processing' }))

    const r = await run({ resumeFromExecutionId: 'orig-1' }, harness).result
    expect(r.status).toBe(200)
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
  })

  it('a successful replay writes its result back to the cache', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    await run({ parentExecutionId: 'orig-1' }, harness).result
    await harness.flush()

    const entry = await kvEntry(harness.store)
    expect(entry?.status).toBe('complete')
    expect(entry?.response).toEqual({ decision: 'ok' })
  })

  it('a failed replay leaves an existing cached result untouched', async () => {
    mockNodesFail()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    const original = JSON.stringify({ status: 'complete', response: { good: true }, responseStatus: 200 })
    harness.store.set(`idempotent-${WF_ID}-${key}`, original)

    await run({ parentExecutionId: 'orig-1' }, harness).result
    await harness.flush()

    expect(harness.store.get(`idempotent-${WF_ID}-${key}`)).toBe(original)
  })
})

describe('test runs', () => {
  it('neither read from nor write to the idempotency cache', async () => {
    mockNodesSucceed()
    const harness = makeHarness()
    const key = await deriveIdempotencyKey(PAYLOAD, ['email'])
    const original = JSON.stringify({ status: 'complete', response: { live: true } })
    harness.store.set(`idempotent-${WF_ID}-${key}`, original)

    const r = await run({ isTest: true }, harness).result
    await harness.flush()

    // Executed for real (no replay of the live entry)…
    expect(r.idempotentReplay).toBeUndefined()
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
    // …and the live entry was not overwritten by the test run.
    expect(harness.store.get(`idempotent-${WF_ID}-${key}`)).toBe(original)
  })
})
