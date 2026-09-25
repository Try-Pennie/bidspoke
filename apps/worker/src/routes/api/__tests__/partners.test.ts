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
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { readBuyerSale, readBuyerSoldOn, refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
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
  })})

// #1541, #1543: the cap-count route reads the Partner Bid node's daily cap
// object. A click sold buyer is never counted there, so its zero would read as
// no clicks today; it answers with the click counter's distinct count instead.
describe('GET /partners/:id/cap-count for a click sold buyer', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const CLICK_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
  const stubFetch = vi.fn(async (url: string) => new Response(JSON.stringify({ count: new URL(url).pathname === '/member-count' ? 23 : 7 })))
  const names: string[] = []
  const capEnv = { ...testEnv, DAILY_CAP: { idFromName: (n: string) => { names.push(n); return n }, get: () => ({ fetch: stubFetch }) } } as unknown as Env

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { single: { slug: 'liberty1' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    app = await makeApp()
  })

  const get = (id = 'p-1') => app.request(`/partners/${id}/cap-count`, { method: 'GET', headers: { Authorization: 'Bearer tok' } }, capEnv, mockCtx)

  it('answers the click counter\'s count on the Pacific day and never reads the daily cap object', async () => {
    names.length = 0
    vi.mocked(readBuyerSoldOn).mockResolvedValue('click')
    const res = await get(CLICK_ID)
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; date: string; sold_on: string; day_zone: string }
    expect(body).toMatchObject({ sold_on: 'click', count: 23, day_zone: 'America/Los_Angeles' })
    expect(names).toEqual([`clicks-${CLICK_ID}-${body.date}`])
    expect(stubFetch.mock.calls.map(([u]) => new URL(u).pathname)).toEqual(['/member-count'])
  })

  it('a click counter that fails is 503, never a zero', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readBuyerSoldOn).mockResolvedValue('click')
    stubFetch.mockImplementationOnce(async () => new Response('boom', { status: 500 }))
    const res = await get(CLICK_ID)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'click_count_unavailable' })
  })

  it('an offer buyer, or a partner with no profile, still gets the daily cap count', async () => {
    for (const kind of ['offer', null] as const) {
      vi.mocked(readBuyerSoldOn).mockResolvedValue(kind)
      const res = await get()
      expect(res.status, String(kind)).toBe(200)
      expect(await res.json()).toMatchObject({ count: 7 })
    }
  })

  it('a kind that cannot be read is 503, never a count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readBuyerSoldOn).mockRejectedValue(new Error('buyer_profiles: timeout'))
    const res = await get()
    expect(res.status).toBe(503)
    expect(stubFetch).not.toHaveBeenCalled()
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
    // A deleted partner leaves the buyer profile snapshot too (#1411).
    expect(vi.mocked(refreshBuyerProfilesCache).mock.calls.map((call) => call[0])).toEqual(['org-abc'])
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

// #1561: the click URL lives on the partner record, and the Engine offer refuses
// one without {prospect_id} on every lead (#1546). validateProfile refuses
// ENABLING a click buyer with such a URL, so this route refuses BREAKING the URL
// of one already enabled, with the same code and the field path the partner form
// renders on its Click URL field. Only that one change is judged: any other
// partner, and any save that leaves the URL alone, saves as before.
describe('PUT /partners/:id refuses a click URL an enabled click buyer cannot be offered on (#1561)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const STORED = 'https://trypennie.com/portal/libertyone/{prospect_id}'
  const BROKEN = 'https://trypennie.com/portal/libertyone/'

  function supabaseFor(stored: string = STORED) {
    return makeSupabase({
      users: { single: testUser },
      partner_configs: [{ single: { id: 'p-1', click_url: stored } }, { updateResult: { id: 'p-1', click_url: BROKEN } }],
    }) as unknown as ReturnType<typeof createSupabaseClient>
  }

  function put(body: unknown) {
    return app.request(
      '/partners/p-1',
      { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
      testEnv,
      mockCtx
    )
  }

  const wrote = (sb: ReturnType<typeof createSupabaseClient>) =>
    ((sb as unknown as { calls: Record<string, Array<[string, unknown[]]>> }).calls.partner_configs ?? []).some((call) => call[0] === 'update')

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(readBuyerSale).mockReset()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('an enabled click buyer is refused with a 422 carrying click_url_has_no_prospect_id on clickUrl, and nothing is written', async () => {
    vi.mocked(readBuyerSale).mockResolvedValue({ soldOn: 'click', isEnabled: true })
    const sb = supabaseFor()
    vi.mocked(createSupabaseClient).mockReturnValue(sb)
    const res = await put({ name: 'Liberty1', click_url: BROKEN })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string; message: string; errors: Array<{ code: string; path: string; message: string }> }
    expect(body.error).toBe('click_url_has_no_prospect_id')
    expect(body.message).toContain('{prospect_id}')
    expect(body.errors).toEqual([{ code: 'click_url_has_no_prospect_id', path: 'clickUrl', message: body.message }])
    expect(wrote(sb)).toBe(false)
    expect(vi.mocked(readBuyerSale).mock.calls[0].slice(1)).toEqual(['org-abc', 'p-1'])
  })

  it('clearing the click URL of an enabled click buyer is refused the same way', async () => {
    vi.mocked(readBuyerSale).mockResolvedValue({ soldOn: 'click', isEnabled: true })
    const sb = supabaseFor()
    vi.mocked(createSupabaseClient).mockReturnValue(sb)
    const res = await put({ click_url: null })
    expect(res.status).toBe(422)
    expect(wrote(sb)).toBe(false)
  })

  it('a disabled click buyer, an offer buyer and a partner with no profile save the same URL as before', async () => {
    for (const sale of [{ soldOn: 'click', isEnabled: false }, { soldOn: 'offer', isEnabled: true }, null] as const) {
      vi.mocked(readBuyerSale).mockResolvedValue(sale)
      const sb = supabaseFor()
      vi.mocked(createSupabaseClient).mockReturnValue(sb)
      const res = await put({ click_url: BROKEN })
      expect(res.status, JSON.stringify(sale)).toBe(200)
      expect(wrote(sb), JSON.stringify(sale)).toBe(true)
    }
    expect(readBuyerSale).toHaveBeenCalledTimes(3)
  })

  it('a click URL carrying the placeholder saves without reading the profile', async () => {
    const sb = supabaseFor()
    vi.mocked(createSupabaseClient).mockReturnValue(sb)
    const res = await put({ click_url: 'https://trypennie.com/portal/libertyone/v2/{prospect_id}' })
    expect(res.status).toBe(200)
    expect(readBuyerSale).not.toHaveBeenCalled()
  })

  it('an unreadable profile refuses a change to the click URL with a 503 on the field, and writes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readBuyerSale).mockRejectedValue(new Error('buyer_profiles: timeout'))
    const sb = supabaseFor()
    vi.mocked(createSupabaseClient).mockReturnValue(sb)
    const res = await put({ name: 'Liberty1', click_url: BROKEN })
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string; message: string; errors: Array<{ path: string }> }
    expect(body.error).toBe('click_url_unverifiable')
    expect(body.message).toMatch(/click URL/)
    expect(body.errors.map((e) => e.path)).toEqual(['clickUrl'])
    expect(wrote(sb)).toBe(false)
  })

  it('an unreadable profile does not stop a save that leaves the click URL as stored, or does not send it', async () => {
    // The stored URL already lacks the placeholder, so only the unchanged value
    // (never the placeholder) is what lets this save through without a read.
    vi.mocked(readBuyerSale).mockRejectedValue(new Error('buyer_profiles: timeout'))
    for (const body of [{ name: 'Liberty1', click_url: BROKEN }, { name: 'Liberty1' }]) {
      const sb = supabaseFor(BROKEN)
      vi.mocked(createSupabaseClient).mockReturnValue(sb)
      const res = await put(body)
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(wrote(sb)).toBe(true)
    }
    expect(readBuyerSale).not.toHaveBeenCalled()
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

  it('PUT invalidates the buyer profile snapshot on every field, because the snapshot joins the partner row (#1411)', async () => {
    // The endpoint, the credential name, the accept rules, the mapping and the
    // active flag all ride into the cached snapshot, so an edit that skipped the
    // invalidation would sell against the old values for up to a minute.
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseForUpdate({ id: 'p-1', name: 'Renamed' }))
    const res = await send('PUT', '/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(vi.mocked(refreshBuyerProfilesCache).mock.calls.map((call) => call[0])).toEqual(['org-abc'])
  })

  it('PUT accepts accept_signals beside response_classification and writes them to the row (#1412)', async () => {
    const accept = [{ field: 'ok', equals: true }, { field: 'data.createLead.resultCode', in: [1000, 1001] }]
    const sb = supabaseForUpdate({ id: 'p-1', accept_signals: accept })
    vi.mocked(createSupabaseClient).mockReturnValue(sb)
    const res = await send('PUT', '/partners/p-1', { accept_signals: accept })
    expect(res.status).toBe(200)
    const update = (sb as unknown as { calls: Record<string, Array<[string, unknown[]]>> }).calls.partner_configs.find((c) => c[0] === 'update')
    expect(update?.[1][0]).toMatchObject({ accept_signals: accept })
  })

  it('PUT does not invalidate the buyer profile snapshot when the write matched nothing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: [{ single: { id: 'p-1' } }, { single: null }] }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await send('PUT', '/partners/p-1', { name: 'Renamed' })
    expect(res.status).toBe(404)
    expect(vi.mocked(refreshBuyerProfilesCache)).not.toHaveBeenCalled()
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
