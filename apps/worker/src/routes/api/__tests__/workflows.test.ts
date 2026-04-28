/**
 * Workflow CRUD routes — PRD Section 1.3
 * Covers: PUT version snapshot + KV invalidation, PATCH is_active toggle,
 * DELETE, version restore, test runner endpoint.
 * Auth rejection is covered in workflows-auth.test.ts.
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

/**
 * Flexible multi-call mock.
 * Each table entry can be a single config OR an array of configs consumed in order.
 * The last entry in an array is reused once exhausted.
 */
type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
  insertResult?: Record<string, unknown> | null
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
          if (prop === 'insert') {
            return () => {
              const res = cfg.insertResult
              const ic: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  // Don't intercept 'then' — let bare `await insert(...)` resolve immediately
                  if (p === 'then') return undefined
                  if (p === 'select') return () => ic
                  if (p === 'single') return () =>
                    res !== undefined && res !== null
                      ? Promise.resolve({ data: res, error: null })
                      : Promise.resolve({ data: null, error: { message: 'insert failed' } })
                  return () => ic
                },
              })
              return ic
            }
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
const existingWorkflow = { id: 'wf-1', name: 'Lead Routing', organization_id: USER_ORG, definition: { nodes: [] } }
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

describe('PUT /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when workflow does not belong to the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-other', { body: { name: 'x' } })
    expect(res.status).toBe(404)
  })

  it('creates a version snapshot and returns the new version_id', async () => {
    const newVersion = { id: 'ver-1', version_number: 2, workflow_id: 'wf-1' }
    const updatedWorkflow = { ...existingWorkflow, name: 'Renamed' }

    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // workflows: first call fetches existing, second call is the update
        workflows: [
          { single: existingWorkflow },
          { single: updatedWorkflow },
        ],
        // workflow_versions: first call gets last version number, second call inserts
        workflow_versions: [
          { single: { version_number: 1 } },
          { insertResult: newVersion },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )

    const res = await request(app, 'PUT', '/workflows/wf-1', { body: { name: 'Renamed' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { version_id: string }
    expect(body.version_id).toBe('ver-1')
  })

  it('calls invalidateWorkflowCache with the workflow id', async () => {
    const newVersion = { id: 'ver-2', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [] } } })
    expect(vi.mocked(invalidateWorkflowCache)).toHaveBeenCalledWith('wf-1', expect.anything())
  })

  it('writes an audit log entry', async () => {
    const newVersion = { id: 'ver-3', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [] } } })
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-1', 'updated', 'user-1', expect.anything()
    )
  })
})

describe('PATCH /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when workflow does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-missing', { body: { is_active: false } })
    expect(res.status).toBe(404)
  })

  it('returns 200 with updated fields', async () => {
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: false, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [
          { single: existingWorkflow },  // ownership check
          { single: updated },           // update result
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: false } })
    expect(res.status).toBe(200)
    const body = await res.json() as { is_active: boolean }
    expect(body.is_active).toBe(false)
  })

  it('calls invalidateWorkflowCache', async () => {
    const updated = { id: 'wf-1', name: 'Lead Routing', is_active: true, updated_at: '2026-01-01' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PATCH', '/workflows/wf-1', { body: { is_active: true } })
    expect(vi.mocked(invalidateWorkflowCache)).toHaveBeenCalledWith('wf-1', expect.anything())
  })
})

describe('DELETE /workflows/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 200 ok', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/workflows/wf-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('calls invalidateWorkflowCache', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/workflows/wf-1')
    expect(vi.mocked(invalidateWorkflowCache)).toHaveBeenCalledWith('wf-1', expect.anything())
  })

  it('writes an audit log entry', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/workflows/wf-1')
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-1', 'deleted', 'user-1'
    )
  })
})

describe('POST /workflows/:id/versions/:version_id/restore', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when version does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-ghost/restore')
    expect(res.status).toBe(404)
  })

  it('returns 200 with the new version number', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },              // fetch target version
          { single: { version_number: 3 } },   // get current max version number
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; version_number: number }
    expect(body.ok).toBe(true)
    expect(typeof body.version_number).toBe('number')
  })

  it('invalidates the workflow cache after restore', async () => {
    const oldVersion = { id: 'ver-1', definition: { nodes: [] }, version_number: 1 }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_versions: [
          { single: oldVersion },
          { single: { version_number: 3 } },
          { insertResult: { id: 'ver-4', version_number: 4 } },
        ],
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'POST', '/workflows/wf-1/versions/ver-1/restore')
    expect(vi.mocked(invalidateWorkflowCache)).toHaveBeenCalledWith('wf-1', expect.anything())
  })
})

describe('POST /workflows/:id/test', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when workflow does not belong to org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-ghost/test', { body: { payload: {} } })
    expect(res.status).toBe(404)
  })

  it('calls executeWorkflow with isTest: true', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-test',
      idempotentReplay: false,
    })

    const testPayload = { lead_id: 'L42' }
    await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: testPayload } })

    expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: true, workflowId: 'wf-1', payload: testPayload }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('sets X-Trace-Id on the response', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(executeWorkflow).mockResolvedValue({
      response: { ok: true },
      status: 200,
      executionId: 'exec-test', traceId: 'trace-xyz',
      idempotentReplay: false,
    })

    const res = await request(app, 'POST', '/workflows/wf-1/test', { body: { payload: {} } })
    expect(res.headers.get('X-Trace-Id')).toBe('trace-xyz')
  })
})
