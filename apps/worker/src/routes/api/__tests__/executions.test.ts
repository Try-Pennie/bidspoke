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

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidateWorkflowCache } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { executeWorkflow } from '../../../engine/index'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
}

function makeSupabase(tables: Record<string, TableConfig | TableConfig[]> = {}) {
  const callCounts: Record<string, number> = {}

  return {
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)]

      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'single') {
            return () => cfg.single !== undefined
              ? cfg.single
                ? Promise.resolve({ data: cfg.single, error: null })
                : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
              : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
          }
          return () => chain
        },
      })
      return chain
    },
  }
}

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
})

describe('GET /executions/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when execution does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/executions/exec-ghost')
    expect(res.status).toBe(404)
  })

  it('returns 404 when execution belongs to another org', async () => {
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

describe('POST /executions/:id/replay', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
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
