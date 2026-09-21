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

  // The delete goes through delete_partner_config (#1409), which records the
  // actor on the audit row the table trigger writes. The route itself writes no
  // audit row any more: one record per change, from the table, never two.
  function deleteApp(rpcResult: { data: unknown; error: unknown }) {
    const rpc = vi.fn().mockResolvedValue(rpcResult)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }, { rpc }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    return rpc
  }

  it('calls delete_partner_config with the org, the id, the actor and their email, and invalidates the constants cache', async () => {
    const rpc = deleteApp({ data: null, error: null })
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('delete_partner_config', {
      p_org: 'org-abc', p_id: 'p-1', p_actor: 'user-1', p_actor_email: 'dan@pennie.com',
    })
    expect(vi.mocked(invalidatePartnerConstantsCache)).toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 404 when the function reports the partner is not there (P0002), and writes no audit log', async () => {
    // #588: the existence read succeeded but the row raced away or is another
    // org's. The function refuses by name and nothing is audited as deleted.
    deleteApp({ data: null, error: { code: 'P0002', message: 'partner_not_found' } })
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('returns 409 naming what blocks the delete when the function refuses partner_has_dependents (BP023)', async () => {
    deleteApp({ data: null, error: { code: 'BP023', message: 'partner_has_dependents', details: 'Key (id)=(p-1) is still referenced from table "buyer_sales".' } })
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('buyer_sales')
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the function call hits a real DB error', async () => {
    // A transient write failure must surface as a retryable 500, never a 404.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deleteApp({ data: null, error: { code: '42P01', message: 'relation missing' } })
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
    // credential_warning is derived per response, not stored (#416); a partner
    // declaring no credential carries an explicit null rather than nothing, so a
    // reader can tell "checked, fine" from "not checked".
    expect(await res.json()).toEqual({ ...updated, credential_warning: null })
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

// #416. #411 made a missing partner credential fail loudly at RUN time, on a live
// lead. This adds the cheaper preventive half: the settings surface says so the
// moment you look at the partner, not only once a lead has already been lost.
//
// The warning is attached on READ as well as on write. A missing credential is a
// condition that PERSISTS in the config (LESSONS L126), so a notice that appears
// only in the save response would be gone on the next visit while the fault
// stayed, and every encounter after the first would find the problem named
// nowhere.
describe('partner credential warning (#416)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const PARTNER = {
    id: 'p-1',
    slug: 'sofi',
    name: 'SoFi',
    cf_secret_key: 'SOFI_SECRET',
    partner_type: 'buyer',
    is_active: true,
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function envWith(vars: Record<string, string>): Env {
    return { SUPABASE_JWKS_URL: 'https://fake.jwks', ...vars } as unknown as Env
  }

  function get(path: string, env: Env) {
    return app.request(path, { method: 'GET', headers: { Authorization: 'Bearer tok' } }, env, mockCtx)
  }

  it('warns on the list when a declared credential is unset', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { list: [PARTNER] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners', envWith({}))
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<{ credential_warning: string | null }>
    expect(rows[0].credential_warning).toContain('SOFI_SECRET')
  })

  it('does not warn on the list when the declared credential resolves', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { list: [PARTNER] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners', envWith({ SOFI_SECRET: 'sk-live' }))
    const rows = await res.json() as Array<{ credential_warning: string | null }>
    expect(rows[0].credential_warning).toBeNull()
  })

  it('does not warn for a partner that declares no credential', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: { list: [{ ...PARTNER, cf_secret_key: null }] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners', envWith({}))
    const rows = await res.json() as Array<{ credential_warning: string | null }>
    expect(rows[0].credential_warning).toBeNull()
  })

  it('never puts the credential VALUE in the response', async () => {
    // The route reads the secret to decide whether it exists, so the response is
    // the one place it could leak. Asserted against a resolvable secret, because
    // an unset one has no value to leak and the check would pass vacuously.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { list: [PARTNER] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners', envWith({ SOFI_SECRET: 'sk-live-do-not-echo' }))
    const body = await res.text()
    expect(body).not.toContain('sk-live-do-not-echo')
    expect(body).toContain('SOFI_SECRET')
  })

  it('names the key, not the value, in the warning itself', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { list: [{ ...PARTNER, cf_secret_key: 'SOFI_SECRET' }] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners', envWith({ SOFI_SECRET: '   ' }))
    const rows = await res.json() as Array<{ credential_warning: string | null }>
    // A whitespace-only secret is TRUTHY, so the bid path would send it as a
    // bearer token. The warning must agree with that rather than second-guess it,
    // which is the whole point of sharing one predicate: a settings page that
    // flagged this would raise an alarm no bid failure ever corroborates.
    expect(rows[0].credential_warning).toBeNull()
  })

  it('says an ACTIVE partner will fail live leads', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { single: PARTNER } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners/p-1', envWith({}))
    const row = await res.json() as { credential_warning: string }
    expect(row.credential_warning).toMatch(/live lead/i)
  })

  it('says an INACTIVE partner must have it set before activation', async () => {
    // Distinct cause, distinct message (LESSONS L11): an inactive partner is not
    // losing leads today, so telling it that it is would be false and would
    // teach the reader to discount the warning.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: { single: { ...PARTNER, is_active: false } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await get('/partners/p-1', envWith({}))
    const row = await res.json() as { credential_warning: string }
    expect(row.credential_warning).toMatch(/before/i)
    expect(row.credential_warning).not.toMatch(/live lead/i)
  })

  it('warns in the PUT response, computed from the row as saved', async () => {
    // Read from the WRITTEN row, not the request body: a save that only toggles
    // is_active sends no cf_secret_key, and a body-derived check would report the
    // partner clean on exactly the save that activates it.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { id: 'p-1' } }, { updateResult: PARTNER }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await app.request(
      '/partners/p-1',
      { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ is_active: true }) },
      envWith({}),
      mockCtx
    )
    expect(res.status).toBe(200)
    const row = await res.json() as { credential_warning: string }
    expect(row.credential_warning).toContain('SOFI_SECRET')
  })

  it('warns in the POST response for a newly created partner', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { insertResult: PARTNER } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await app.request(
      '/partners',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ name: 'SoFi', slug: 'sofi', cf_secret_key: 'SOFI_SECRET' }) },
      envWith({}),
      mockCtx
    )
    expect(res.status).toBe(201)
    const row = await res.json() as { credential_warning: string }
    expect(row.credential_warning).toContain('SOFI_SECRET')
  })

  it('still saves the partner when the credential is missing', async () => {
    // The warning must not become a block: a partner is routinely configured
    // before its secret is provisioned, and refusing the save would leave no way
    // to record the key that has to be provisioned.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { id: 'p-1' } }, { updateResult: PARTNER }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await app.request(
      '/partners/p-1',
      { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ cf_secret_key: 'SOFI_SECRET' }) },
      envWith({}),
      mockCtx
    )
    expect(res.status).toBe(200)
    // The route writes no audit row of its own: the partner_configs table trigger
    // records the change with updated_by as the actor (#1409).
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
