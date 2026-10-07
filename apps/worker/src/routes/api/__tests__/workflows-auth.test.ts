/**
 * REST API — workflow CRUD auth tests
 * PRD Section 1.3: valid JWT, invalid JWT, wrong org scoping
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/slack')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { refreshWorkflowCaches } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { makeSupabase } from './_supabase-mock'

// ── Supabase chain mock ───────────────────────────────────────────────────────

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'

const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const testWorkflow = { id: 'wf-1', name: 'Lead Routing', organization_id: USER_ORG, is_active: true }

const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp() {
  // Import the full api router (includes jwtAuth + all routes)
  const { default: api } = await import('../index')
  return api
}

function req(method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== undefined) headers['Authorization'] = opts.auth
  return {
    method,
    path,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }
}

function request(app: { request: Function }, method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const { headers, body } = req(method, path, opts)
  return app.request(path, { method, headers, body }, testEnv)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('REST API — auth rejection', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  describe('missing Authorization header', () => {
    it('GET /workflows → 401', async () => {
      const res = await request(app, 'GET', '/workflows')
      expect(res.status).toBe(401)
    })

    it('POST /workflows → 401', async () => {
      const res = await request(app, 'POST', '/workflows', { body: { name: 'test' } })
      expect(res.status).toBe(401)
    })

    it('GET /workflows/wf-1 → 401', async () => {
      const res = await request(app, 'GET', '/workflows/wf-1')
      expect(res.status).toBe(401)
    })

    it('DELETE /workflows/wf-1 → 401', async () => {
      const res = await request(app, 'DELETE', '/workflows/wf-1')
      expect(res.status).toBe(401)
    })
  })

  describe('invalid Authorization header', () => {
    it('non-Bearer token → 401', async () => {
      const res = await request(app, 'GET', '/api/workflows', { auth: 'Basic abc123' })
      expect(res.status).toBe(401)
    })

    it('Bearer with invalid JWT → 401', async () => {
      vi.mocked(verifyJwt).mockRejectedValue(new Error('Invalid JWT signature'))
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'GET', '/workflows', { auth: 'Bearer bad.jwt.token' })
      expect(res.status).toBe(401)
    })

    it('Bearer with expired JWT → 401', async () => {
      vi.mocked(verifyJwt).mockRejectedValue(new Error('JWT expired'))
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request(app, 'GET', '/workflows', { auth: 'Bearer expired.jwt.token' })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/invalid|expired/i)
    })
  })

  describe('valid JWT but user not in database', () => {
    it('returns 401 when user record is missing', async () => {
      vi.mocked(verifyJwt).mockResolvedValue(validPayload)
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
      )
      const res = await request(app, 'GET', '/workflows', { auth: 'Bearer valid.jwt.token' })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/user not found/i)
    })
  })
})

// ── Org scoping ───────────────────────────────────────────────────────────────

describe('REST API — org scoping', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('GET /:id — returns 404 when workflow belongs to a different org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },  // .eq('organization_id', orgId) finds nothing
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-other', { auth: 'Bearer tok' })
    expect(res.status).toBe(404)
  })

  it('PUT /:id — returns 404 when workflow belongs to a different org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/workflows/wf-other', {
      auth: 'Bearer tok',
      body: { name: 'Renamed' },
    })
    expect(res.status).toBe(404)
  })

  // The soft delete is org-scoped, so another org's workflow matches zero rows.
  // PostgREST calls that a success, and this route used to pass it straight
  // through as 200 {ok:true}: a caller could not tell a delete that worked from
  // one that silently touched nothing in a workflow it does not own (#588).
  it('DELETE /:id: returns 404 when the workflow belongs to a different org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { writeRows: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/workflows/wf-other', { auth: 'Bearer tok' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
  })

  it('DELETE /:id: scopes the soft delete to the caller org', async () => {
    const supabase = makeSupabase({ users: { single: testUser }, workflows: { writeRows: [{ id: 'wf-1' }] } })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'DELETE', '/workflows/wf-1', { auth: 'Bearer tok' })
    expect(res.status).toBe(200)
    expect(supabase.eqCalls['workflows']).toEqual([
      ['id', 'wf-1'],
      ['organization_id', USER_ORG],
    ])
  })

  it('GET /:id/versions — returns 404 when workflow belongs to a different org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-other/versions', { auth: 'Bearer tok' })
    expect(res.status).toBe(404)
  })
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('REST API — happy path', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshWorkflowCaches).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('GET /workflows — returns 200 with workflow list', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { list: [testWorkflow] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows', { auth: 'Bearer tok' })
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /workflows/:id — returns 200 with workflow', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: testWorkflow },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/workflows/wf-1', { auth: 'Bearer tok' })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string }
    expect(body.id).toBe('wf-1')
  })

  it('POST /workflows — returns 400 when name is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows', {
      auth: 'Bearer tok',
      body: {},
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/name/i)
  })

  it('POST /workflows — returns 201 with created workflow', async () => {
    const created = { id: 'wf-new', name: 'New Workflow', organization_id: USER_ORG }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { insertResult: created },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/workflows', {
      auth: 'Bearer tok',
      body: { name: 'New Workflow' },
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; name: string }
    expect(body.name).toBe('New Workflow')
  })
})
