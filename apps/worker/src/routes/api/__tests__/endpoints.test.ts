/**
 * Custom webhook endpoints routes (#76) — workflow ownership is org-scoped.
 * An endpoint maps a public subdomain/path to a workflow that runs with that
 * workflow's org's env vars/secrets, so create/update must reject a workflow_id
 * that doesn't belong to the caller's org (the service-role key bypasses RLS).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { makeSupabase } from './_supabase-mock'

// ── Supabase mock (per-table, call-count-indexed) ─────────────────────────────

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const ownWorkflow = { id: 'wf-mine' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body ? JSON.stringify(body) : undefined,
  }, testEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /endpoints — workflow org check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  const body = { subdomain: 'rml', source_name: 'rml', workflow_id: 'wf-other' }

  it('returns 404 when the workflow belongs to another org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: null }, // cross-org: not found in caller's org
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/endpoints', body)
    expect(res.status).toBe(404)
  })

  it('returns 500 (not a false 404) when the ownership check hits a real DB error (#303)', async () => {
    // A real DB error reported as 404 would block a legitimate publish. PGRST116
    // (no row) is the only "not found"; any other error must surface.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { singleError: { code: '57P01', message: 'db down' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/endpoints', body)
    expect(res.status).toBe(500)
  })

  it('creates the endpoint when the workflow belongs to the caller', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: ownWorkflow },
        webhook_endpoints: { insertResult: { id: 'ep-1', subdomain: 'rml', path: '', workflow_id: 'wf-mine', source_name: 'rml', is_active: true } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/endpoints', { ...body, workflow_id: 'wf-mine' })
    expect(res.status).toBe(201)
    // #105: audited as webhook_endpoint (was mislabeled environment_variable) with the real id.
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'webhook_endpoint', 'ep-1', 'created', 'user-1', expect.anything()
    )
  })
})

describe('PUT /endpoints/:id — workflow org check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when re-pointing to a workflow in another org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: { single: { subdomain: 'rml', path: '' } }, // endpoint is the caller's
        workflows: { single: null },                                   // but the new workflow isn't
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/endpoints/ep-1', { workflow_id: 'wf-other' })
    expect(res.status).toBe(404)
  })
})
