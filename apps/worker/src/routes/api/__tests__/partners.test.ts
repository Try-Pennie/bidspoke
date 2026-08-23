/**
 * Partner routes — #320 (the false-404 class, 5697088).
 * GET /:id and GET /:id/cap-count must return a retryable 5xx when the
 * partner_configs lookup hits a real DB error, and 404 only for a missing partner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const DB_ERROR = { code: '57014', message: 'canceling statement due to statement timeout' }

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string) {
  return app.request(path, { method, headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)
}

describe('Partner routes — DB error => 5xx, not 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('GET /:id returns 404 for a genuinely missing partner', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/partners/missing')
    expect(res.status).toBe(404)
  })

  it('GET /:id returns 5xx (not a false 404) when the lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { singleError: DB_ERROR } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/partners/p-1')
    expect(res.status).toBe(500)
  })

  it('GET /:id/cap-count returns 5xx (not a false 404) when the lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { singleError: DB_ERROR } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/partners/p-1/cap-count')
    expect(res.status).toBe(500)
  })
})

describe('DELETE /partners/:id: zero-row + DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 and writes no audit log when the delete matches zero rows', async () => {
    // #588: the existence read succeeds but the DELETE touches nothing (the row
    // raced away or is another org's). Auditing it would log a delete that never
    // happened.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { slug: 'sofi', name: 'SoFi' } }, { writeRows: [] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    // A transient write failure must surface as a retryable 500, never a 404.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { slug: 'sofi', name: 'SoFi' } }, { deleteError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #595: PUT /:id ends its write in .update().select().single(). PostgREST
// answers a zero-row match there with PGRST116, which the old
// `if (error) return dbError(c, error)` turned into a 500. It must be a 404,
// while a genuine DB error must still surface as a retryable 500.
describe('PUT /partners/:id: zero-row 404 vs real DB error (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

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
      testEnv,
      mockCtx
    )
  }

  it('returns 404 (not 500) and skips audit + cache when the update matches zero rows', async () => {
    // Ownership read finds the row, then the UPDATE touches nothing (raced away
    // or another org). That zero-row write must read as not-found, not an error.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { id: 'p-1' } }, { single: null }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { id: 'p-1' } }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated row on the happy path', async () => {
    const updated = { id: 'p-1', name: 'Renamed', slug: 'sofi' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { id: 'p-1' } }, { updateResult: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updated)
  })

  // #596: the ownership READ preceding the update used the bare
  // `if (fetchError) return 404` form. A real DB error on that read must be a
  // retryable 500, not a 404 that says the partner is gone during a blip.
  it('returns 500 (not a false 404) when the ownership read hits a real DB error (#596)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: { singleError: DB_ERROR },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await put('/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #306 / ADR 0001. `partner_type` gained a third value `both`. The form's option
// list and the values this route accepts are ONE vocabulary (LESSONS L89), so the
// route validates against that list rather than letting the database CHECK be the
// only gate: a CHECK violation surfaces as an opaque 500, which reads as "the
// service is broken" rather than "that is not a partner type".
describe('partner_type vocabulary on the write path (#306)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function send(method: 'POST' | 'PUT', path: string, body: unknown) {
    return app.request(
      path,
      { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
      testEnv,
      mockCtx
    )
  }

  function supabaseForUpdate(updated: Record<string, unknown>) {
    return makeSupabase({
      users: { single: testUser },
      partner_configs: [{ single: { id: 'p-1' } }, { updateResult: updated }],
    }) as unknown as ReturnType<typeof createSupabaseClient>
  }

  it('PUT accepts partner_type both and persists it', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseForUpdate({ id: 'p-1', partner_type: 'both' }))
    const res = await send('PUT', '/partners/p-1', { partner_type: 'both' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ partner_type: 'both' })
  })

  it('PUT refuses an unknown partner_type with a 400 naming the accepted values', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseForUpdate({ id: 'p-1' }))
    const res = await send('PUT', '/partners/p-1', { partner_type: 'seller' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('seller')
    expect(body.error).toContain('both')
  })

  it('PUT writes nothing when the partner_type is refused', async () => {
    // A 400 that still ran the update would have stored the bad value and only
    // reported the refusal, which is worse than no validation at all.
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseForUpdate({ id: 'p-1' }))
    await send('PUT', '/partners/p-1', { partner_type: 'seller' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('POST refuses an unknown partner_type with a 400', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: { single: { id: 'p-new' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await send('POST', '/partners', { name: 'Seller Co', slug: 'seller-co', partner_type: 'seller' })
    expect(res.status).toBe(400)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('POST accepts partner_type both', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: { insertResult: { id: 'p-new', partner_type: 'both' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await send('POST', '/partners', { name: 'Engine', slug: 'engine', partner_type: 'both' })
    expect(res.status).toBe(201)
  })
})
