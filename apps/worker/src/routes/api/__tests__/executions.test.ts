/**
 * Execution routes — PRD Section 1.3
 * Covers: list scoped to org, get by ID (with steps), cross-org 404,
 * replay creates fresh execution, resume passes resumeFromExecutionId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
vi.mock('../../../engine/index')
vi.mock('../../../lib/archive-read')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidateWorkflowCache } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { executeWorkflow } from '../../../engine/index'
import { readArchivedExecution, readArchivedChildren, readArchivedParentSteps, searchArchive } from '../../../lib/archive-read'
import { makeSupabase } from './_supabase-mock'

// ── Supabase mock ─────────────────────────────────────────────────────────────

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const testWorkflow = { id: 'wf-1', organization_id: USER_ORG }
const testExecution = {
  id: 'exec-1',
  workflow_id: 'wf-1',
  status: 'completed',
  source: 'website_form',
  trigger_payload: { lead: 'data' },
  started_at: '2026-01-01T00:00:00Z',
  duration_ms: 150,
}
const testSteps = [
  { id: 'step-1', execution_id: 'exec-1', step_order: 1, namespace: 'filter_1', status: 'completed' },
]

const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
} as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(app: { request: Function }, method: string, path: string, opts: { body?: unknown } = {}) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, testEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /executions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(readArchivedExecution).mockResolvedValue({ kind: 'not-found' })
    vi.mocked(readArchivedChildren).mockResolvedValue({ kind: 'ok', children: [] })
    vi.mocked(readArchivedParentSteps).mockResolvedValue({ kind: 'not-found' })
    app = await makeApp()
  })

  it('returns 200 with execution list', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { list: [testWorkflow] },
        workflow_executions: { list: [testExecution] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions')
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  it('returns empty array when org has no workflows', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { list: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions')
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(body).toEqual([])
  })

  it('returns 404 when workflow_id filter does not belong to org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions?workflow_id=wf-other')
    expect(res.status).toBe(404)
  })

  // #106: cursor params are interpolated into the .or() filter, so a malformed
  // value (e.g. one containing a comma/paren) must be rejected, not passed through.
  it('returns 400 for a malformed keyset cursor', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { list: [testWorkflow] },
        workflow_executions: { list: [testExecution] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const inject = encodeURIComponent('2026-01-01T00:00:00Z,id.lt.x')
    const res = await request(app, 'GET', `/executions?before=${inject}&before_id=not-a-uuid`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
  })

  it('accepts a well-formed keyset cursor', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { list: [testWorkflow] },
        workflow_executions: { list: [testExecution] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(
      app,
      'GET',
      '/executions?before=2026-01-01T00:00:00Z&before_id=3f9c1e2a-1d23-496c-b046-b11d64edae29'
    )
    expect(res.status).toBe(200)
  })
})

// #231: shadow runs are written is_test=true with a `__shadow` source suffix, so
// the default list (is_test=false) excludes them. `?shadow=1` flips the scope to
// surface them in their own view.
describe('GET /executions?shadow=1', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('scopes to test rows with the __shadow source suffix', async () => {
    // The shared mock records every chained builder call per table, so the
    // filter scoping a route applied can be asserted directly (#347).
    const client = makeSupabase({
      users: { single: testUser },
      workflows: { single: testWorkflow },
      workflow_executions: { list: [testExecution] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(client as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'GET', '/executions?workflow_id=wf-1&shadow=1')
    expect(res.status).toBe(200)
    const execCalls = client.calls.workflow_executions ?? []
    expect(execCalls).toContainEqual(['eq', ['is_test', true]])
    expect(execCalls).toContainEqual(['like', ['source', '%__shadow']])
    expect(execCalls).not.toContainEqual(['eq', ['is_test', false]])
  })

  it('defaults to non-test rows when shadow is not set', async () => {
    // The shared mock records every chained builder call per table, so the
    // filter scoping a route applied can be asserted directly (#347).
    const client = makeSupabase({
      users: { single: testUser },
      workflows: { single: testWorkflow },
      workflow_executions: { list: [testExecution] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(client as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'GET', '/executions?workflow_id=wf-1')
    expect(res.status).toBe(200)
    const execCalls = client.calls.workflow_executions ?? []
    expect(execCalls).toContainEqual(['eq', ['is_test', false]])
    expect(execCalls).not.toContainEqual(['like', ['source', '%__shadow']])
  })
})

describe('GET /executions/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(readArchivedExecution).mockResolvedValue({ kind: 'not-found' })
    app = await makeApp()
  })

  // Since #874 a miss in Postgres is not the answer on its own: past the seven
  // day retention the row is gone from Postgres and may still be in the
  // archive. 404 now means neither holds it.
  it('returns 404 when neither Postgres nor the archive holds the execution', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-ghost')
    expect(res.status).toBe(404)
    expect(vi.mocked(readArchivedExecution)).toHaveBeenCalled()
  })

  it('returns the archived execution when Postgres has dropped it', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(readArchivedExecution).mockResolvedValue({
      kind: 'found',
      execution: { id: 'exec-old', workflow_id: 'wf-1', status: 'completed' },
      steps: [{ id: 'step-1', step_namespace: 'validate', input: { a: 1 }, output: { b: 2 } }],
      archiveDay: '2026-03-04',
      archivedIncomplete: false,
    })
    const res = await request(app, 'GET', '/executions/exec-old')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.archived).toBe(true)
    expect(body.archive_day).toBe('2026-03-04')
    expect(body.id).toBe('exec-old')
    expect(body.steps).toHaveLength(1)
  })

  it('strips heavy step payloads from an archived execution under ?summary=1', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(readArchivedExecution).mockResolvedValue({
      kind: 'found',
      execution: { id: 'exec-old', workflow_id: 'wf-1', status: 'completed' },
      steps: [{ id: 'step-1', step_namespace: 'validate', input: { a: 1 }, output: { b: 2 }, logs: ['x'] }],
      archiveDay: '2026-03-04',
      archivedIncomplete: false,
    })
    const res = await request(app, 'GET', '/executions/exec-old?summary=1')
    const body = await res.json() as { steps: Array<Record<string, unknown>> }
    expect(body.steps[0]).not.toHaveProperty('input')
    expect(body.steps[0]).not.toHaveProperty('output')
    expect(body.steps[0]).not.toHaveProperty('logs')
    expect(body.steps[0].step_namespace).toBe('validate')
  })

  // The whole reason the archive read reports three outcomes rather than two.
  // A 404 here would tell an operator a lead never ran when the only thing that
  // happened is that the warehouse was asleep.
  it('returns 503, not 404, when the archive cannot be reached', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(readArchivedExecution).mockResolvedValue({
      kind: 'unavailable',
      waitingFor: 'the execution archive',
      detail: 'the archive did not answer within 20 seconds',
    })
    const res = await request(app, 'GET', '/executions/exec-old')
    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.waiting_for).toBe('the execution archive')
    expect(body.detail).toContain('20 seconds')
  })

  it('returns 404 when execution belongs to another org, in Postgres and in the archive', async () => {
    // Ownership check is now an inner join on workflows.organization_id —
    // when the org doesn't match, PostgREST returns no row for the parent.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
        execution_steps: { list: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-1')
    expect(res.status).toBe(404)
  })

  it('returns 200 with execution and steps', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { single: testWorkflow },
        execution_steps: { list: testSteps },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; steps: unknown[] }
    expect(body.id).toBe('exec-1')
    expect(body.steps).toHaveLength(1)
  })
})

describe('DB error => retryable 5xx, not a false 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const DB_ERROR = { code: '57014', message: 'canceling statement due to statement timeout' }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'new', response: { status: 200 } } as never)
    app = await makeApp()
  })

  it('GET /:id returns 5xx when the execution lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-1')
    expect(res.status).toBe(500)
  })

  it('GET /:id/steps/:stepId returns 5xx when the step lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        execution_steps: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-1/steps/step-1')
    expect(res.status).toBe(500)
  })

  it('POST /:id/resume returns 5xx when the execution lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/executions/exec-1/resume')
    expect(res.status).toBe(500)
  })

  it('POST /:id/replay returns 5xx when the execution lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/executions/exec-1/replay')
    expect(res.status).toBe(500)
  })

  // #596: the SECOND lookup (the workflows ownership check) used the bare
  // `if (ownerError) return 404` form. With the first lookup succeeding, an error
  // on the ownership lookup must now surface as a retryable 5xx, not a false 404
  // that tells the caller the row is gone during a transient DB blip.
  it('GET /:id/steps/:stepId returns 5xx when the OWNERSHIP lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        execution_steps: { single: testSteps[0] },
        workflow_executions: { single: testExecution },
        workflows: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-1/steps/step-1')
    expect(res.status).toBe(500)
  })

  it('POST /:id/resume returns 5xx when the OWNERSHIP lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/executions/exec-1/resume')
    expect(res.status).toBe(500)
  })

  it('POST /:id/replay returns 5xx when the OWNERSHIP lookup errors (not 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/executions/exec-1/replay')
    expect(res.status).toBe(500)
  })
})

describe('POST /executions/:id/replay', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(readArchivedExecution).mockResolvedValue({ kind: 'not-found' })
    app = await makeApp()
  })

  it('returns 404 when execution does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/executions/exec-ghost/replay')
    expect(res.status).toBe(404)
  })

  it('calls executeWorkflow without resumeFromExecutionId', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { single: testWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-replay',
      idempotentReplay: false,
    })

    await request(app, 'POST', '/executions/exec-1/replay')

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.not.objectContaining({ resumeFromExecutionId: expect.anything() }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('sets X-Trace-Id on the response', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { single: testWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-replay-123',
      idempotentReplay: false,
    })

    const res = await request(app, 'POST', '/executions/exec-1/replay')
    expect(res.headers.get('X-Trace-Id')).toBe('trace-replay-123')
  })
})

describe('POST /executions/:id/resume', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(readArchivedExecution).mockResolvedValue({ kind: 'not-found' })
    app = await makeApp()
  })

  it('calls executeWorkflow with resumeFromExecutionId set to the execution id', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: testExecution },
        workflows: { single: testWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-resume',
      idempotentReplay: false,
    })

    await request(app, 'POST', '/executions/exec-1/resume')

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ resumeFromExecutionId: 'exec-1' }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })
})

// Issue #79: the org-ownership check must run BEFORE the KV cache read, or a
// cross-org caller could read another org's cached duration percentiles.
describe('GET /executions/step-duration-stats — org check precedes cache', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  function envWithCache(cacheGet: ReturnType<typeof vi.fn>) {
    return {
      ...testEnv,
      WORKFLOW_CACHE: { get: cacheGet, put: vi.fn() },
    } as unknown as Env
  }

  it('returns 404 without reading the cache when the workflow is in another org', async () => {
    const cacheGet = vi.fn().mockResolvedValue(JSON.stringify({ leaked: true }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null }, // cross-org: not owned
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await app.request(
      '/executions/step-duration-stats?workflow_id=wf-other&namespace=foo',
      { method: 'GET', headers: { Authorization: 'Bearer tok' } },
      envWithCache(cacheGet),
      mockCtx,
    )
    expect(res.status).toBe(404)
    expect(cacheGet).not.toHaveBeenCalled() // never reached the cache
  })

  it('serves the cache for a workflow the caller owns', async () => {
    const cacheGet = vi.fn().mockResolvedValue(JSON.stringify({ p50: 42 }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: testWorkflow }, // owned
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await app.request(
      '/executions/step-duration-stats?workflow_id=wf-1&namespace=foo',
      { method: 'GET', headers: { Authorization: 'Bearer tok' } },
      envWithCache(cacheGet),
      mockCtx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ p50: 42 })
    expect(cacheGet).toHaveBeenCalled()
  })
})

describe('archived lineage on the detail route (#874)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(readArchivedExecution).mockResolvedValue({ kind: 'not-found' })
    vi.mocked(readArchivedChildren).mockResolvedValue({ kind: 'ok', children: [] })
    vi.mocked(readArchivedParentSteps).mockResolvedValue({ kind: 'not-found' })
    app = await makeApp()
  })

  const archivedParent = {
    kind: 'found' as const,
    execution: { id: 'exec-old', workflow_id: 'wf-1', status: 'completed' },
    steps: [],
    archiveDay: '2026-03-04',
    archivedIncomplete: false,
  }

  it('lists the replay and resume runs created from an archived execution', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(readArchivedExecution).mockResolvedValue(archivedParent)
    vi.mocked(readArchivedChildren).mockResolvedValue({
      kind: 'ok',
      children: [{ id: 'child-1', status: 'completed', source: 'replay', started_at: null, outcome: null }],
    })

    const res = await request(app, 'GET', '/executions/exec-old')
    const body = await res.json() as Record<string, unknown>
    const children = body.child_executions as Array<{ id: string }>
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('child-1')
    // A list that WAS established carries no doubt marker, so an empty one
    // beside it genuinely means none.
    expect(body.child_executions_unavailable).toBeUndefined()
  })

  it('still serves the execution when the children lookup cannot be answered', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(readArchivedExecution).mockResolvedValue(archivedParent)
    vi.mocked(readArchivedChildren).mockResolvedValue({
      kind: 'unavailable', waitingFor: 'the execution archive', detail: 'no answer',
    })

    // The run itself is already in hand. Refusing the whole page because a
    // secondary lookup failed would withhold what the person asked for.
    const res = await request(app, 'GET', '/executions/exec-old')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.id).toBe('exec-old')
    // But it must SAY it could not tell. An empty list alone would read as
    // "nothing was ever re-run from this", which nothing established.
    expect(body.child_executions_unavailable).toBe(true)
  })
})

describe('GET /executions/archive-search (#874)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    // Cleared, because one assertion here is that the DETAIL route did not
    // handle this path, and a call recorded by an earlier test would answer
    // that question with another test's history (L205).
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    app = await makeApp()
  })

  it('is not mistaken for an execution id', async () => {
    vi.mocked(searchArchive).mockResolvedValue({
      kind: 'ok', results: [], coverage: { complete: true, completeFrom: null, note: null },
    })

    const res = await request(app, 'GET', '/executions/archive-search?trace_id=abc')

    expect(res.status).toBe(200)
    // The detail route must not have handled it; the search did.
    expect(vi.mocked(searchArchive)).toHaveBeenCalled()
    expect(vi.mocked(readArchivedExecution)).not.toHaveBeenCalled()
  })

  it('returns the coverage caveat alongside the results', async () => {
    vi.mocked(searchArchive).mockResolvedValue({
      kind: 'ok',
      results: [{ execution_id: 'exec-1' }],
      coverage: { complete: false, completeFrom: '2026-08-20', note: 'Runs before 2026-08-20 may be missing.' },
    })

    const res = await request(app, 'GET', '/executions/archive-search?ssn=123-45-6789')
    const body = await res.json() as { results: unknown[]; coverage: { complete: boolean; note: string } }

    expect(body.results).toHaveLength(1)
    expect(body.coverage.complete).toBe(false)
    expect(body.coverage.note).toContain('2026-08-20')
  })

  it('refuses a search with no term', async () => {
    vi.mocked(searchArchive).mockResolvedValue({
      kind: 'refused', reason: 'a trace id or an SSN is required',
    })

    const res = await request(app, 'GET', '/executions/archive-search')
    expect(res.status).toBe(400)
  })

  it('answers 503, not an empty result list, when the archive cannot be reached', async () => {
    vi.mocked(searchArchive).mockResolvedValue({
      kind: 'unavailable', waitingFor: 'the execution archive', detail: 'no answer',
    })

    const res = await request(app, 'GET', '/executions/archive-search?trace_id=abc')

    // An empty 200 would read as "this person was never seen".
    expect(res.status).toBe(503)
  })
})
