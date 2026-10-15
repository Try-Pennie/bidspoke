/**
 * The partners page live channel's two Worker routes (#2135, PR4 of #2114).
 *
 * GET /partners/:id/versions is the page's delivery probe: while a draft is
 * dirty it asks every 60 seconds for the two versions, the press that last
 * saved, and whether the newest change had no actor, and on open and every
 * refetch it reads the newest change of each half for the "Changed directly in
 * the database" notice. POST /partners/live-miss records a change the probe
 * found that no notice announced, the data the miss threshold will be set from.
 * Both: any allowlisted member of the organization, that organization's rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const ORG = 'org-abc'
const PARTNER = '33333333-3333-3333-3333-333333333333'
const SAVE = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function wire(tables: Record<string, TableConfig | TableConfig[]>) {
  const supabase = makeSupabase({ users: { single: testUser }, ...tables })
  vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
  return supabase
}

const PARTNER_ROW = { id: PARTNER, version: 7, last_save_id: SAVE }
const PROFILE_ROW = { version: 3, last_save_id: null }
const EDITOR_PARTNER_AUDIT = {
  changed_at: '2026-10-15T14:00:00+00:00', changed_by: 'user-2',
  changes: { daily_cap: { old: 40, new: 50 }, _actor: { name: 'Erin', email: 'erin@example.test' } },
}
const DIRECT_PARTNER_AUDIT = {
  changed_at: '2026-10-15T15:00:00+00:00', changed_by: null,
  changes: { sell_off_offer_title: { old: 'a', new: 'b' }, _source: 'direct_sql' },
}
const DIRECT_PROFILE_AUDIT = {
  changed_at: '2026-10-15T15:30:00+00:00', changed_by: null,
  changes: { _source: 'direct_sql', table: 'buyer_pricing_tiers', op: 'UPDATE', rows: 2 },
}

describe('GET /partners/:id/versions (#2135)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const get = (id = PARTNER) => app.request(`/partners/${id}/versions`, { headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)

  it('answers both versions, the last press, and the newest change of each half, the latest of them direct', async () => {
    const supabase = wire({
      partner_configs: { single: PARTNER_ROW },
      buyer_profiles: { maybeSingle: PROFILE_ROW },
      audit_log: [{ list: [EDITOR_PARTNER_AUDIT] }, { list: [DIRECT_PROFILE_AUDIT] }],
    })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      partnerId: PARTNER,
      partnerVersion: 7,
      profileVersion: 3,
      lastSaveId: SAVE,
      profileLastSaveId: null,
      latestChange: { section: 'profile', changedAt: '2026-10-15T15:30:00+00:00', direct: true, fields: ['buyer_pricing_tiers'] },
      newest: {
        partner: { changedAt: '2026-10-15T14:00:00+00:00', direct: false, fields: ['daily_cap'] },
        profile: { changedAt: '2026-10-15T15:30:00+00:00', direct: true, fields: ['buyer_pricing_tiers'] },
      },
    })
    // Every read is this organization's.
    expect(supabase.eqCalls['partner_configs']).toEqual([['id', PARTNER], ['organization_id', ORG]])
    expect(supabase.eqCalls['buyer_profiles']).toEqual([['partner_id', PARTNER], ['organization_id', ORG]])
    expect(supabase.eqCalls['audit_log']).toEqual([
      ['organization_id', ORG], ['entity_type', 'partner_config'], ['entity_id', PARTNER],
      ['organization_id', ORG], ['entity_type', 'buyer_profile'], ['entity_id', PARTNER],
    ])
  })

  it('names the direct partner columns, and a partner with no profile and no history reads as profile 0 and no change', async () => {
    wire({ partner_configs: { single: PARTNER_ROW }, buyer_profiles: { maybeSingle: null }, audit_log: [{ list: [DIRECT_PARTNER_AUDIT] }, { list: [] }] })
    const body = await (await get()).json() as Record<string, unknown>
    expect(body).toMatchObject({
      profileVersion: 0,
      latestChange: { section: 'partner', direct: true, fields: ['sell_off_offer_title'] },
      newest: { profile: null },
    })

    wire({ partner_configs: { single: PARTNER_ROW }, buyer_profiles: { maybeSingle: null }, audit_log: [{ list: [] }, { list: [] }] })
    expect(await (await get()).json()).toMatchObject({ latestChange: null, newest: { partner: null, profile: null } })
  })

  it('answers 404 for a partner outside the organization, and 500 for a real read failure, never a version of 0', async () => {
    wire({ partner_configs: { single: null } })
    expect((await get()).status).toBe(404)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ partner_configs: { single: PARTNER_ROW }, buyer_profiles: { maybeSingle: PROFILE_ROW }, audit_log: [{ listError: { code: '57014', message: 'timeout' } }] })
    expect((await get()).status).toBe(500)
  })
})

describe('POST /partners/live-miss (#2135)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const post = (body: unknown) => app.request('/partners/live-miss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify(body),
  }, testEnv, mockCtx)

  const report = {
    partner_id: PARTNER,
    cause: 'delivery',
    noticed: { partner_version: 6, profile_version: 3 },
    observed: { partner_version: 7, profile_version: 3 },
    since_last_notice_ms: 61_000,
  }

  it('records the miss against this organization and the person who saw it', async () => {
    const supabase = wire({ partner_configs: { single: { id: PARTNER } }, partner_page_live_misses: { insertResult: { id: 'miss-1' } } })
    const res = await post(report)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: 'miss-1' })
    expect(supabase.eqCalls['partner_configs']).toEqual([['id', PARTNER], ['organization_id', ORG]])
    const insert = (supabase.calls['partner_page_live_misses'] ?? []).find(([m]) => m === 'insert')
    expect(insert?.[1][0]).toEqual({
      organization_id: ORG,
      partner_id: PARTNER,
      reported_by: 'user-1',
      cause: 'delivery',
      noticed_partner_version: 6,
      noticed_profile_version: 3,
      observed_partner_version: 7,
      observed_profile_version: 3,
      since_last_notice_ms: 61_000,
    })
  })

  it('refuses a malformed report by the field it got wrong, before any read', async () => {
    const supabase = wire({ partner_configs: { single: { id: PARTNER } } })
    const res = await post({ ...report, cause: 'sleep' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'live_miss_invalid', field: 'cause' })
    expect(supabase.calls['partner_configs']).toBeUndefined()
  })

  it('answers 404 for a partner outside the organization and records nothing', async () => {
    const supabase = wire({ partner_configs: { single: null } })
    expect((await post(report)).status).toBe(404)
    expect(supabase.calls['partner_page_live_misses']).toBeUndefined()
  })

  it('answers 500 when the record cannot be written, never a false success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ partner_configs: { single: { id: PARTNER } }, partner_page_live_misses: { insertError: { code: '42501', message: 'permission denied' } } })
    expect((await post(report)).status).toBe(500)
  })
})
