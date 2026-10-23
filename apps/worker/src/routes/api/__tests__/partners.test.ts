/**
 * Partner routes — #320 (the false-404 class, 5697088).
 * GET /:id and GET /:id/cap-count must return a retryable 5xx when the
 * partner_configs lookup hits a real DB error, and 404 only for a missing partner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { readBuyerSoldOn } from '../../../lib/buyer-profile-loader'
import { makeSupabase } from './_supabase-mock'
import api from '../index'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
const mockCtx = recordingContext()
const DB_ERROR = { code: '57014', message: 'canceling statement due to statement timeout' }

async function makeApp() {
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

// DELETE /partners/:id moved to partner-delete.ts (#2140); its tests are in partner-delete.test.ts.

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

  function send(method: 'POST', path: string, body: unknown) {
    return app.request(
      path,
      { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
      testEnv,
      mockCtx
    )
  }

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
    // The settled design's words (PM-23, #2326, frame 18): what is missing, where
    // it is set, what happens next to this partner, and who adds it.
    expect(row.credential_warning).toBe("SOFI_SECRET is not set as a Worker secret, so SoFi's next bid will fail. An engineer adds it in Cloudflare.")
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
    expect(row.credential_warning).toBe('SOFI_SECRET is not set as a Worker secret. An engineer adds it in Cloudflare before SoFi is turned on.')
    expect(row.credential_warning).not.toMatch(/will fail/i)
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

})
