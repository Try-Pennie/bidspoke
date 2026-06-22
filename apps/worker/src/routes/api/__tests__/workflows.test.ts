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
vi.mock('../../../lib/github')
vi.mock('../../../lib/github-backup-alert')
vi.mock('../../../engine/nodes/index')
vi.mock('../../../lib/env-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidateWorkflowCache } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { executeWorkflow } from '../../../engine/index'
import { executeNode } from '../../../engine/nodes/index'
import { loadEnvVars } from '../../../lib/env-loader'
import { pushWorkflowToGitHub } from '../../../lib/github'
import { recordBackupSuccess, recordBackupFailure } from '../../../lib/github-backup-alert'

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
  // Records the columns each table was filtered by, so tests can assert query
  // scoping (e.g. that workflow_executions is scoped by workflow_id, not by a
  // non-existent organization_id column). Keyed by table name.
  const eqCalls: Record<string, Array<[string, unknown]>> = {}

  return {
    eqCalls,
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)]

      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'eq') {
            return (col: string, val: unknown) => {
              (eqCalls[table] ??= []).push([col, val])
              return chain
            }
          }
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
  IDEMPOTENCY: {},
  APP_URL: 'https://app.test',
  GITHUB_TOKEN: 'gh-tok',
  GITHUB_REPO: 'Try-Pennie/backups',
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
    // Backup runs in waitUntil and chains .then/.catch — the auto-mock must return
    // a promise. Default to "not configured" (null) / no-op so unrelated tests are
    // unaffected; the backup-specific tests override these.
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue(null)
    vi.mocked(recordBackupSuccess).mockResolvedValue(undefined)
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
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

  // Drain the promises handed to ctx.waitUntil so the backup .then/.catch settles.
  const drainWaitUntil = () =>
    Promise.all(mockCtx.waitUntil.mock.calls.map((call: unknown[]) => call[0]))

  it('records a successful backup (clears the failure streak) when the push returns a commit sha', async () => {
    vi.mocked(pushWorkflowToGitHub).mockResolvedValue('commit-sha-123')
    const newVersion = { id: 'ver-bk1', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(recordBackupSuccess)).toHaveBeenCalled()
    expect(vi.mocked(recordBackupFailure)).not.toHaveBeenCalled()
  })

  it('records a backup failure (for alerting) when the push throws', async () => {
    vi.mocked(pushWorkflowToGitHub).mockRejectedValue(new Error('GitHub push failed (401): Bad credentials'))
    vi.mocked(recordBackupFailure).mockResolvedValue(false)
    const newVersion = { id: 'ver-bk2', version_number: 2, workflow_id: 'wf-1' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: existingWorkflow }, { single: existingWorkflow }],
        workflow_versions: [{ single: { version_number: 1 } }, { insertResult: newVersion }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'PUT', '/workflows/wf-1', { body: { definition: { nodes: [] } } })
    await drainWaitUntil()
    expect(vi.mocked(recordBackupFailure)).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1' }))
    expect(vi.mocked(recordBackupSuccess)).not.toHaveBeenCalled()
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

describe('POST /workflows/:id/duplicate', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when the source workflow is not in the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/duplicate')
    expect(res.status).toBe(404)
  })

  it('clones the workflow, copies version history, and audit-logs the source', async () => {
    const source = { name: 'Lead Routing', description: null, definition: { nodes: [] }, folder_id: null, is_active: true }
    const clone = { id: 'wf-copy', name: 'Lead Routing (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // 1st workflows call = source select; 2nd = clone insert
        workflows: [{ single: source }, { insertResult: clone }],
        // 1st workflow_versions call = source history select; 2nd = bulk insert
        workflow_versions: [
          { list: [{ version_number: 1, definition: { nodes: [] }, message: 'init' }, { version_number: 2, definition: { nodes: [] }, message: 'edit' }] },
          { insertResult: {} },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string }
    expect(body.id).toBe('wf-copy')
    expect(body.name).toBe('Lead Routing (copy)')
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'workflow', 'wf-copy', 'created', 'user-1', { duplicated_from: 'wf-1' }
    )
  })

  it('seeds a baseline v1 when the source has no saved versions', async () => {
    const source = { name: 'Fresh', description: null, definition: { nodes: [] }, folder_id: null, is_active: false }
    const clone = { id: 'wf-copy2', name: 'Fresh (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: source }, { insertResult: clone }],
        workflow_versions: [{ list: [] }, { insertResult: {} }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string }
    expect(body.id).toBe('wf-copy2')
  })

  it('succeeds when the source has code nodes (deploy path runs, no CF creds = no-op)', async () => {
    const source = {
      name: 'Coded',
      description: null,
      definition: { nodes: [{ id: 'n1', type: 'code', namespace: 'enrich', config: { script: 'return {}' } }] },
      folder_id: null,
      is_active: true,
    }
    const clone = { id: 'wf-copy3', name: 'Coded (copy)', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: [{ single: source }, { insertResult: clone }],
        workflow_versions: [{ list: [{ version_number: 1, definition: source.definition }] }, { insertResult: {} }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/duplicate')
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string }
    expect(body.id).toBe('wf-copy3')
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
        workflows: { single: existingWorkflow },  // ownership passes — exercise the version lookup
        workflow_versions: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-1/versions/ver-ghost/restore')
    expect(res.status).toBe(404)
  })

  it('returns 404 and writes nothing when the workflow belongs to another org', async () => {
    // Ownership lookup is org-scoped — a workflow in another org yields no row,
    // so the handler must bail before touching versions, the definition, or the
    // cache. (Service-role key bypasses RLS, so this check is the only guard.)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },                 // cross-org: ownership fails
        workflow_versions: { single: { id: 'ver-1', definition: { nodes: [] }, version_number: 1 } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/versions/ver-1/restore')
    expect(res.status).toBe(404)
    // No definition overwrite, no version-history insert, no cache bust, no audit.
    expect(vi.mocked(invalidateWorkflowCache)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
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

describe('POST /workflows/:id/test-node', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(loadEnvVars).mockResolvedValue({})
    vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } } as unknown as Awaited<ReturnType<typeof executeNode>>)
    app = await makeApp()
  })

  // Regression: the resume-from-execution branch must scope the execution lookup
  // to the (already org-verified) workflow via workflow_id. It previously filtered
  // by organization_id — a column that doesn't exist on workflow_executions — so
  // with the service-role client the query errored at runtime and this path always
  // 404'd. Typing the Supabase client now blocks the bad column at compile time;
  // this locks in the correct scoping at runtime.
  it('scopes the resume-from-execution lookup by workflow_id, not organization_id', async () => {
    const supa = makeSupabase({
      users: { single: testUser },
      workflows: { single: existingWorkflow },
      workflow_executions: { single: { trigger_payload: { lead: 'L1' }, trace_id: 'tr-old', source: 'webhook' } },
      execution_steps: { list: [] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supa as unknown as ReturnType<typeof createSupabaseClient>)

    const definition = {
      nodes: [{ id: 'n1', namespace: 'n1', type: 'exit', config: {} }],
      edges: [],
      trigger: { type: 'http_webhook', config: {} },
    }
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', {
      body: { namespace: 'n1', definition, execution_id: 'exec-99' },
    })

    expect(res.status).toBe(200)
    const execFilters = supa.eqCalls['workflow_executions'] ?? []
    expect(execFilters).toContainEqual(['workflow_id', 'wf-1'])
    expect(execFilters.some(([col]) => col === 'organization_id')).toBe(false)
  })
})

describe('GET /workflows/:id/timeout-suggestions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const wfRow = {
    id: 'wf-1',
    updated_at: '2026-06-11T00:00:00Z',
    definition: {
      nodes: [
        { id: 'equifax', namespace: 'equifax', type: 'code', config: { timeout_ms: 4000 } },
        { id: 'thin', namespace: 'thin', type: 'code', config: { timeout_ms: 1000 } },
      ],
    },
  }

  function kvEnv(kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }) {
    return { ...testEnv, WORKFLOW_CACHE: kv } as unknown as Env
  }

  function requestWithEnv(env: Env) {
    return app.request('/workflows/wf-1/timeout-suggestions', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    }, env, mockCtx)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns 404 when the workflow does not belong to the org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(404)
  })

  it('returns per-node suggestions from the grouped RPC and caches the payload', async () => {
    // equifax clears SAMPLE_CONFIDENT in the first (2h) window and must lock
    // there: the wider windows return different stats for it, which a correct
    // implementation ignores.
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [
          { step_namespace: 'equifax', p50: 438, p99: 5000, max_ms: 11000, sample_size: 1996 },
          { step_namespace: 'thin', p50: 50, p99: 100, max_ms: 200, sample_size: 3 },
        ],
        error: null,
      })
      .mockResolvedValue({
        data: [
          { step_namespace: 'equifax', p50: 900, p99: 9000, max_ms: 20000, sample_size: 5000 },
          { step_namespace: 'thin', p50: 50, p99: 100, max_ms: 200, sample_size: 3 },
        ],
        error: null,
      })
    const sb = Object.assign(makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }), { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    const body = await res.json() as { window_days: number; nodes: Array<Record<string, unknown>> }

    // equifax has a real sample: default retries (2) -> suggested = p99 * 1.5,
    // computed from the FIRST window's stats (locked, despite the wider windows
    // reporting p99 9000 for it).
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({
      node_id: 'equifax',
      namespace: 'equifax',
      configured_ms: 4000,
      retries: 2,
      suggested_ms: 7500,
      p50: 438,
      p99: 5000,
      sample_size: 1996,
      window_days: 2 / 24,
    })
    // 'thin' never reached a confident sample, so the route widened through all
    // three windows before giving up on it.
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(body.window_days).toBe(7)
    expect(kv.put).toHaveBeenCalledWith(
      'timeout-suggestions:v3:wf-1:2026-06-11T00:00:00Z',
      expect.any(String),
      { expirationTtl: 1800 }
    )
  })

  it('serves the KV-cached payload without hitting the RPC', async () => {
    const rpc = vi.fn()
    const sb = Object.assign(makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }), { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const cached = { window_days: 1, nodes: [] }
    const kv = { get: vi.fn().mockResolvedValue(JSON.stringify(cached)), put: vi.fn() }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('degrades to an empty node list when the RPC errors (statement timeout)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'statement timeout' } })
    const sb = Object.assign(makeSupabase({
      users: { single: testUser },
      workflows: { single: wfRow },
    }), { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    vi.mocked(createSupabaseClient).mockReturnValue(sb)

    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }
    const res = await requestWithEnv(kvEnv(kv))
    expect(res.status).toBe(200)
    const body = await res.json() as { nodes: unknown[] }
    expect(body.nodes).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})

describe('POST /workflows/:id/test-node', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const nodeBody = {
    namespace: 'n1',
    definition: { trigger: { id: 't', type: 'trigger', config: {} }, nodes: [{ id: 'n1', namespace: 'n1', type: 'filter', config: {} }], edges: [] },
    trigger_payload: {},
  }

  it('returns 404 when the workflow belongs to another org (before any deploy/execute)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },  // cross-org: ownership fails
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows/wf-other/test-node', { body: nodeBody })
    expect(res.status).toBe(404)
  })

  it('passes ownership for the caller’s own workflow (reaches the handler body)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: existingWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    // Omit `definition` so the handler answers 400 — proves it got PAST the
    // ownership check (404) into its own validation, without exercising the
    // code-deploy / executeNode path.
    const res = await request(app, 'POST', '/workflows/wf-1/test-node', { body: { namespace: 'n1' } })
    expect(res.status).toBe(400)
  })
})
