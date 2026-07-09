/**
 * Webhook route through the real engine to a 409, for an in-flight duplicate (#482).
 *
 * The other route tests mock executeWorkflow, so they only prove Hono relays a
 * status the engine already handed it. This one runs the REAL engine against an
 * IDEMPOTENCY KV that already holds a 'processing' marker (the exact state a
 * second copy of the same lead lands in while the first is still executing),
 * and asserts the whole chain terminates in a 409 at the HTTP boundary.
 *
 * What it guards: a duplicate lead must be rejected, not executed a second time
 * (double partner bids) and not answered 200 (source believes it was accepted).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { WorkflowDefinition } from '../../types'

// engine/index is deliberately NOT mocked: it is the code under test here.
// Its collaborators are the definition load, the env/constants preload, and
// node execution. The 409 returns before any node runs, so mocking executeNode
// lets us assert it was never called.
vi.mock('../../engine/definition-loader', async () => {
  const actual = await vi.importActual<typeof import('../../engine/definition-loader')>(
    '../../engine/definition-loader'
  )
  return { ...actual, loadWorkflowDefinition: vi.fn() }
})
vi.mock('../../lib/env-loader', () => ({ loadEnvVars: vi.fn().mockResolvedValue({}) }))
vi.mock('../../lib/partner-constants-loader', () => ({
  loadPartnerConstants: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../engine/nodes/index')
vi.mock('../../lib/supabase')

import { loadWorkflowDefinition } from '../../engine/definition-loader'
import { executeNode } from '../../engine/nodes/index'
import { createSupabaseClient } from '../../lib/supabase'
import webhooks from '../webhooks'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = 'wf-dup'
const SOURCE = 'website_form'
const IDEM_KEY = 'lead-42'
const API_KEY = 'sk_test_key'

const definition = {
  trigger: { id: 'trigger', type: 'trigger', config: { idempotency: { enabled: true } } },
  nodes: [{ id: 'a', namespace: 'step_a', type: 'code', config: { retries: 0 } }],
  edges: [],
} as unknown as WorkflowDefinition

// In-memory KV, pre-seeded by the caller.
function makeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    async get(k: string, type?: string) {
      const raw = store.get(k)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

// enforceSourceAssignment does one select/eq/eq chain; an empty result means
// "source unrestricted", which is what the route's enforceSourceAssignment:true
// resolves to for this fixture.
const supabase = {
  from: () => ({
    select: () => ({
      eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
} as unknown as SupabaseClient

/** POST the lead through the real route + engine, with the given IDEMPOTENCY KV. */
function post(idempotencyKV: KVNamespace) {
  const env = {
    API_KEY_MAP: JSON.stringify({ [API_KEY]: SOURCE }),
    IDEMPOTENCY: idempotencyKV,
    WORKFLOW_CACHE: makeKV(),
    APP_URL: 'https://app.test',
    PII_REDACTION_FIELDS: '',
  } as unknown as Env

  const background: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext

  const res = webhooks.request(
    `/${WF_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-Idempotency-Key': IDEM_KEY,
      },
      body: JSON.stringify({ email: 'lead@example.com' }),
    },
    env,
    executionCtx
  )
  return { res, flush: () => Promise.all(background) }
}

const markerKey = `idempotent-${WF_ID}-${SOURCE}-${IDEM_KEY}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createSupabaseClient).mockReturnValue(supabase as ReturnType<typeof createSupabaseClient>)
  vi.mocked(loadWorkflowDefinition).mockResolvedValue({
    definition,
    workflow_version_id: 'v1',
    workflow_name: 'Dup Test',
    org_id: 'org-1',
    slack_channel: null,
    capture_sightings: false,
  })
  vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/:workflow_id (in-flight duplicate, #482)', () => {
  it('returns 409 when the engine finds a processing marker for this lead', async () => {
    const kv = makeKV({ [markerKey]: JSON.stringify({ status: 'processing' }) })
    const { res } = post(kv)
    const response = await res

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Duplicate request in progress' })
  })

  it('does not execute any node for the rejected duplicate', async () => {
    const kv = makeKV({ [markerKey]: JSON.stringify({ status: 'processing' }) })
    const { res, flush } = post(kv)
    await res
    await flush()

    // The whole point of the 409: the lead must not be bid on twice.
    expect(vi.mocked(executeNode)).not.toHaveBeenCalled()
  })

  it('leaves the processing marker intact so the in-flight run still owns it', async () => {
    const kv = makeKV({ [markerKey]: JSON.stringify({ status: 'processing' }) })
    const { res, flush } = post(kv)
    await res
    await flush()

    // Clearing it here would let a third copy of the lead execute for real
    // while the original is still running.
    expect(await kv.get(markerKey, 'json')).toEqual({ status: 'processing' })
  })

  it('executes normally (200) when no marker is present', async () => {
    const { res, flush } = post(makeKV())
    const response = await res
    await flush()

    expect(response.status).toBe(200)
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
  })
})
