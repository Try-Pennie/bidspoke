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
// The create route retires the copies at the new address (#1846), so the cache needs a delete.
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { delete: async () => {} } } as unknown as Env

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

describe('DELETE /endpoints/:id: zero-row + DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  // A KV cache with a spy so we can prove a no-op delete does not invalidate it.
  const cacheDelete = vi.fn()
  const envWithCache = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { delete: cacheDelete } } as unknown as Env

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function del(path: string) {
    return app.request(path, { method: 'DELETE', headers: { Authorization: 'Bearer tok' } }, envWithCache, mockCtx)
  }

  it('returns 404 and skips the KV cache + audit log when the delete matches zero rows', async () => {
    // #588: PostgREST reports a zero-row DELETE as a plain success. The row is
    // gone (or belonged to another org), so invalidating KV and writing an audit
    // line would both record work that never happened.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // Existence lookup finds the row, then the DELETE touches nothing.
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/' } }, { writeRows: [] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await del('/endpoints/ep-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Endpoint not found' })
    expect(cacheDelete).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    // A transient write failure must not masquerade as a 404: that would tell the
    // caller the endpoint is gone for good. This is the #303 conflation, on the
    // write side (#588).
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/' } }, { deleteError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await del('/endpoints/ep-1')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #595: PUT /:id ends its write in .update().select().single(). A zero-row match
// there is PGRST116 and must read as a 404, not the old 500. The duplicate-key
// (23505) branch runs before the not-found check, so it must still return 409,
// and a genuine DB error must still surface as a retryable 500.
describe('PUT /endpoints/:id: zero-row 404, duplicate 409, real DB error 500 (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const cacheDelete = vi.fn()
  const envWithCache = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { delete: cacheDelete } } as unknown as Env
  const existing = { subdomain: 'rml', path: '/' }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function put(path: string, body: unknown) {
    return app.request(
      path,
      { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
      envWithCache,
      mockCtx
    )
  }

  it('returns 404 (not 500), skips audit + KV invalidation when the update matches zero rows', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: existing }, { single: null }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/endpoints/ep-1', { source_name: 'newsrc' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Endpoint not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(cacheDelete).not.toHaveBeenCalled()
  })

  it('returns 409 when the update collides on the subdomain+path unique key', async () => {
    // The 23505 branch runs BEFORE the not-found check, so it must still win.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: existing }, { updateError: { code: '23505', message: 'duplicate key' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/endpoints/ep-1', { source_name: 'newsrc' })
    expect(res.status).toBe(409)
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: existing }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/endpoints/ep-1', { source_name: 'newsrc' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated row on the happy path', async () => {
    const updated = { id: 'ep-1', subdomain: 'rml', path: '/', workflow_id: 'wf-mine', source_name: 'newsrc', is_active: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: existing }, { updateResult: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/endpoints/ep-1', { source_name: 'newsrc' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updated)
  })
})

// ops.trypennie.dev is the ops Worker's host (#1706, plan 0.B and 0.E), so no
// custom endpoint may claim it. Checked read only before reserving it: no
// webhook_endpoints row used the subdomain (0 of 9 on 2026-10-01).
describe('POST /endpoints: the ops subdomain is reserved (#1706)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('refuses ops by name and writes nothing', async () => {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: ownWorkflow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'POST', '/endpoints', { subdomain: 'ops', source_name: 'x', workflow_id: 'wf-mine' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('"ops" is reserved')
    expect((sb.calls.webhook_endpoints ?? []).filter(([m]) => m === 'insert')).toEqual([])
  })
})

// #1846. The custom endpoint route keeps two copies of each endpoint record in
// KV: a 60 second hot copy (ep:) and a durable last-good copy (ep-lastgood:)
// that is served when the webhook_endpoints read fails (#1296). Only the hot
// copy was ever deleted, so in a database outage an endpoint deleted, switched
// off or moved minutes earlier was still served from its durable copy. Every
// write now retires BOTH copies under every key it can have touched, after the
// write lands, so the next successful lookup rewrites them from the row.
describe('every endpoint write retires its stored copies (#1846)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const deleted: string[] = []
  const kvEnv = {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    WORKFLOW_CACHE: { delete: async (k: string) => { deleted.push(k) } },
  } as unknown as Env

  beforeEach(async () => {
    vi.clearAllMocks()
    deleted.length = 0
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: body ? JSON.stringify(body) : undefined,
    }, kvEnv, mockCtx)
  }

  it('POST retires any copy left at the new address, so a reused path never serves an old record', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { single: ownWorkflow },
        webhook_endpoints: { insertResult: { id: 'ep-1', subdomain: 'rml', path: '/bid', workflow_id: 'wf-mine', source_name: 'rml', is_active: true } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await call('POST', '/endpoints', { subdomain: 'rml', path: 'bid', source_name: 'rml', workflow_id: 'wf-mine' })
    expect(res.status).toBe(201)
    expect(deleted.sort()).toEqual(['ep-lastgood:rml:/bid', 'ep:rml:/bid'])
  })

  it('PUT that switches the endpoint off retires both copies, so an outage cannot serve it as active', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/' } }, { updateResult: { id: 'ep-1', subdomain: 'rml', path: '/', is_active: false } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await call('PUT', '/endpoints/ep-1', { is_active: false })
    expect(res.status).toBe(200)
    expect(deleted.sort()).toEqual(['ep-lastgood:rml:/', 'ep:rml:/'])
  })

  it('PUT that moves the endpoint retires the copies at the old address and the new one', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/old' } }, { updateResult: { id: 'ep-1', subdomain: 'acme', path: '/new', is_active: true } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await call('PUT', '/endpoints/ep-1', { subdomain: 'acme', path: 'new' })
    expect(res.status).toBe(200)
    expect(deleted.sort()).toEqual(['ep-lastgood:acme:/new', 'ep-lastgood:rml:/old', 'ep:acme:/new', 'ep:rml:/old'])
  })

  it('DELETE retires both copies, so a deleted endpoint is never served from KV', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/' } }, { writeRows: [{ id: 'ep-1' }] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await call('DELETE', '/endpoints/ep-1')
    expect(res.status).toBe(200)
    expect(deleted.sort()).toEqual(['ep-lastgood:rml:/', 'ep:rml:/'])
  })

  // The delete landed, so it is answered as the success it was and audited. The
  // copy KV would not clear is named in a warning: deleting again would find no
  // row, so the per minute sweep (lib/stored-copy-sweep.ts) is what clears it,
  // and the warning says that rather than naming a step that cannot work (#1846).
  it('answers a delete as done, with a warning, when KV refuses to retire a copy, and still audits it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        webhook_endpoints: [{ single: { subdomain: 'rml', path: '/' } }, { writeRows: [{ id: 'ep-1' }] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const failingEnv = {
      SUPABASE_JWKS_URL: 'https://fake.jwks',
      WORKFLOW_CACHE: { delete: async () => { throw new Error('kv unavailable') } },
    } as unknown as Env
    const res = await app.request('/endpoints/ep-1', { method: 'DELETE', headers: { Authorization: 'Bearer tok' } }, failingEnv, mockCtx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; stored_copy_warning?: string }
    expect(body.ok).toBe(true)
    expect(body.stored_copy_warning).toMatch(/repaired automatically/i)
    expect(body.stored_copy_warning).not.toMatch(/save it again/i)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledTimes(1)
  })
})
