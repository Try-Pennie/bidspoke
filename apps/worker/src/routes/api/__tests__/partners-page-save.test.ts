/**
 * PUT /partners/:id/page: the whole page in one save (#2133, part of #2114).
 *
 * The page used to save the partner record and then the buyer profile in two
 * requests, so a refused profile left the partner half saved. This route runs
 * every check the two routes ran, then makes one call, save_partner_page, which
 * writes both halves at the pair of versions the page was edited from, or
 * neither. A committed save is never answered as an error: each stored copy is
 * refreshed inside copyCleared and a failure is copyWarning (L33).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { readBuyerSale, readBuyerSoldOn, refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { COPY_NOT_CLEARED_MESSAGE } from '../../../lib/stored-copy'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com', display_name: 'Dan Wright' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const SAVE_ID = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'
const ACCEPT = [{ field: 'ok', equals: true }]
/** The partner as the route reads it before the save: its own rules, which the profile is judged against. */
const STORED = { id: 'p-1', click_url: 'https://trypennie.com/portal/tpl', accept_signals: ACCEPT, external_routing_code: 2 }
const ROW = { id: 'p-1', organization_id: 'org-abc', name: 'Tripoint', slug: 'tripoint', is_active: true, cf_secret_key: null, version: 5, last_save_id: SAVE_ID }

const doc: BuyerProfileDocument = {
  partner_id: 'p-1', version: 2, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

type Rpc = ReturnType<typeof vi.fn>

function supabaseWith(rpc: Rpc, tables: Record<string, TableConfig | TableConfig[]> = {}) {
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(
    { users: { single: testUser }, partner_configs: { single: STORED }, workflows: { list: [] }, ...tables },
    { rpc: rpc as unknown as (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  ) as unknown as ReturnType<typeof createSupabaseClient>)
}

function kvDouble() {
  const calls: string[] = []
  return {
    calls,
    kv: {
      delete: async (k: string) => { calls.push(`delete ${k}`) },
      put: async (k: string) => { calls.push(`put ${k}`) },
      get: async () => null,
    },
  }
}

const saved = (over: { partner?: Record<string, unknown>; profile?: unknown } = {}) => vi.fn(async (name: string, _args?: unknown) =>
  name === 'save_partner_page'
    ? { data: { partner: { ...ROW, ...over.partner }, profile: over.profile === undefined ? { ...doc, version: 3 } : over.profile, partner_version: 5, profile_version: 3 }, error: null }
    : { data: null, error: null })

const pageCalls = (rpc: Rpc) => rpc.mock.calls.filter(([n]) => n === 'save_partner_page')

describe('PUT /partners/:id/page: the whole page in one save (#2133)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({} as Awaited<ReturnType<typeof refreshBuyerProfilesCache>>)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    vi.mocked(readBuyerSoldOn).mockResolvedValue('offer')
    vi.mocked(readBuyerSale).mockResolvedValue(null)
    app = await makeApp()
  })

  function put(body: unknown, env: Env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: kvDouble().kv } as unknown as Env) {
    return app.request('/partners/p-1/page', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify(body),
    }, env, mockCtx)
  }

  const page = (over: Record<string, unknown> = {}) => ({
    expected_partner_version: 4, patch: { name: 'Tripoint' }, expected_profile_version: 2, profile: doc, save_id: SAVE_ID, ...over,
  })

  it('makes one call carrying the org, both versions, the patch, the profile less its identity, the press and the actor', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page())
    expect(res.status).toBe(200)
    expect(pageCalls(rpc)).toHaveLength(1)
    const { partner_id: _p, version: _v, ...profileToSave } = doc
    expect(pageCalls(rpc)[0][1]).toEqual({
      p_org: 'org-abc',
      p_partner_id: 'p-1',
      p_expected_partner_version: 4,
      p_patch: { name: 'Tripoint' },
      p_expected_profile_version: 2,
      p_profile: profileToSave,
      p_save_id: SAVE_ID,
      p_client_id: null,
      p_actor: 'user-1',
      p_actor_email: 'dan@pennie.com',
      p_actor_name: 'Dan Wright',
    })
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ partner: { ...ROW, credential_warning: null }, profile: { ...doc, version: 3 }, partner_version: 5, profile_version: 3 })
    expect('stored_copy_warning' in body).toBe(false)
  })

  // #2135: the notice the save sends carries the tab that pressed it, so that
  // tab can tell its own echo from another person's save by client_id plus save_id.
  it('carries the tab that pressed it as p_client_id, and refuses one that is not a UUID before anything is called', async () => {
    const CLIENT = '6f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
    const rpc = saved()
    supabaseWith(rpc)
    expect((await put(page({ client_id: CLIENT }))).status).toBe(200)
    expect(pageCalls(rpc)[0][1]).toMatchObject({ p_save_id: SAVE_ID, p_client_id: CLIENT })

    const refused = saved()
    supabaseWith(refused)
    const res = await put(page({ client_id: 'tab-1' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'client_id_invalid' })
    expect(pageCalls(refused)).toHaveLength(0)
  })

  it('a save of the partner alone sends no profile and no profile version', async () => {
    const rpc = saved({ profile: null })
    supabaseWith(rpc)
    const res = await put(page({ profile: null, expected_profile_version: null }))
    expect(res.status).toBe(200)
    expect(pageCalls(rpc)[0][1]).toMatchObject({ p_profile: null, p_expected_profile_version: null })
  })

  it.each([
    ['no partner version', { expected_partner_version: undefined }],
    ['a partner version below zero', { expected_partner_version: -1 }],
    ['a fractional partner version', { expected_partner_version: 1.5 }],
    ['a save id that is not a UUID', { save_id: 'nope' }],
    ['no save id', { save_id: undefined }],
    ['a patch that is a list', { patch: [] }],
    ['no patch', { patch: undefined }],
    ['a profile with no version it was edited from', { expected_profile_version: null }],
    ['a profile version as text', { expected_profile_version: '2' }],
  ])('refuses %s with 400 and calls nothing', async (_label, over) => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page(over))
    expect(res.status).toBe(400)
    expect(pageCalls(rpc)).toEqual([])
  })

  it('refuses an unknown partner type with 400 before anything is read', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ patch: { partner_type: 'lender' } }))
    expect(res.status).toBe(400)
    expect(pageCalls(rpc)).toEqual([])
  })

  it('answers 404 for a partner outside the org, and calls nothing', async () => {
    const rpc = saved()
    supabaseWith(rpc, { partner_configs: { single: null } })
    expect((await put(page())).status).toBe(404)
    expect(pageCalls(rpc)).toEqual([])
  })

  it('refuses a click URL an enabled click buyer cannot be offered on, on the Click URL field by its registry path', async () => {
    vi.mocked(readBuyerSale).mockResolvedValue({ soldOn: 'click', isEnabled: true } as Awaited<ReturnType<typeof readBuyerSale>>)
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ patch: { click_url: 'https://trypennie.com/portal/libertyone/' }, profile: null, expected_profile_version: null }))
    expect(res.status).toBe(422)
    const body = await res.json() as { errors: Array<{ code: string; path: string; field: string }> }
    expect(body.errors).toEqual([expect.objectContaining({ code: 'click_url_has_no_prospect_id', path: 'clickUrl', field: 'click_url' })])
    expect(pageCalls(rpc)).toEqual([])
  })

  it('a malformed profile document is 400 and calls nothing', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ profile: { ...doc, tiers: 'all of them' } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('profile_malformed')
    expect(pageCalls(rpc)).toEqual([])
  })

  it('a profile the validator refuses is 422 with each error naming its registry path, and calls nothing', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ profile: { ...doc, priority: null, debt_min: 90000, debt_max: 20000 } }))
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string; errors: Array<{ code: string; path: string; field: string }> }
    expect(body.error).toBe('profile_invalid')
    expect(body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'enabled_without_priority', path: 'priority', field: 'profile.priority' }),
      expect.objectContaining({ code: 'debt_min_above_max', path: 'debtMin', field: 'profile.debt_min' }),
    ]))
    expect(pageCalls(rpc)).toEqual([])
  })

  it('judges the profile against the partner as this save leaves it: accept rules added in the same save let it be enabled', async () => {
    const rpc = saved()
    supabaseWith(rpc, { partner_configs: { single: { ...STORED, accept_signals: [] } } })
    const res = await put(page({ patch: { accept_signals: ACCEPT } }))
    expect(res.status).toBe(200)
    expect(pageCalls(rpc)).toHaveLength(1)
  })

  it('and a click URL cleared in the same save refuses the enabled profile, on the partner field', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ patch: { click_url: null } }))
    expect(res.status).toBe(422)
    const body = await res.json() as { errors: Array<{ code: string; field: string }> }
    expect(body.errors).toEqual([expect.objectContaining({ code: 'enabled_without_click_url', field: 'click_url' })])
    expect(pageCalls(rpc)).toEqual([])
  })

  it('refuses a switch away from the click while a live workflow sells the buyer on a click node, naming it, and calls nothing', async () => {
    vi.mocked(readBuyerSoldOn).mockResolvedValue('click')
    const rpc = saved()
    const live = { id: 'wf-1', name: 'Liberty Flow', is_active: true, definition: { nodes: [{ type: 'buyer_click_send', config: { partner_id: 'p-1' } }] } }
    supabaseWith(rpc, { workflows: { list: [live] } })
    const res = await put(page())
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string; message: string })).toMatchObject({ error: 'sold_on_in_use', message: expect.stringContaining('Liberty Flow') })
    expect(pageCalls(rpc)).toEqual([])
  })

  it('answers a stale pair with 409 carrying both halves, the press that last saved and its editor, and does no cache work', async () => {
    const detail = { partner: { ...ROW, name: 'Theirs', version: 6 }, profile: { ...doc, version: 4 }, partner_version: 6, profile_version: 4, last_save_id: 'f0f0f0f0-0000-4000-8000-000000000001', changed_by_name: 'Brian Nelms', changed_at: '2026-10-15T14:02:00Z' }
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify(detail) } }))
    const { kv, calls } = kvDouble()
    supabaseWith(rpc)
    const res = await put(page(), { SUPABASE_JWKS_URL: 'x', WORKFLOW_CACHE: kv } as unknown as Env)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stale_version', ...detail })
    expect(calls).toEqual([])
    expect(invalidatePartnerConstantsCache).not.toHaveBeenCalled()
    expect(refreshBuyerProfilesCache).not.toHaveBeenCalled()
  })

  it('answers a database refusal of the profile with 422 naming its code, its sentence and its registry path', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP422', message: 'tiers_gap', details: 'engine: the first tier starts at 20000, above the debt minimum 15000' } }))
    supabaseWith(rpc)
    const res = await put(page())
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'tiers_gap',
      message: 'engine: the first tier starts at 20000, above the debt minimum 15000',
      errors: [{ code: 'tiers_gap', path: 'tiers', field: 'profile.tiers[*]', message: 'engine: the first tier starts at 20000, above the debt minimum 15000' }],
    })
  })

  it('a field the save may not write is named by its own key', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP422', message: 'field_not_editable', details: 'slug' } }))
    supabaseWith(rpc)
    const res = await put(page({ patch: { slug: 'stolen' } }))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([expect.objectContaining({ code: 'field_not_editable', field: 'slug' })])
  })

  // #2143: the parser builds a new document from the fields it declares, so a
  // display zone it did not declare would be dropped here and never saved.
  it('carries the display time zone to the save and back: Pacific saved reads back Pacific', async () => {
    const rpc = saved({ profile: { ...doc, version: 3, display_time_zone: 'America/Los_Angeles' } })
    supabaseWith(rpc)
    const res = await put(page({ profile: { ...doc, display_time_zone: 'America/Los_Angeles' } }))
    expect(res.status).toBe(200)
    expect((pageCalls(rpc)[0][1] as { p_profile: Record<string, unknown> }).p_profile.display_time_zone).toBe('America/Los_Angeles')
    expect(((await res.json()) as { profile: Record<string, unknown> }).profile.display_time_zone).toBe('America/Los_Angeles')
  })

  it('sends no display time zone when the page did not speak about it, so the stored one is kept', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    expect((await put(page())).status).toBe(200)
    expect('display_time_zone' in (pageCalls(rpc)[0][1] as { p_profile: Record<string, unknown> }).p_profile).toBe(false)
  })

  it('refuses a zone outside the list before calling anything, and names the database refusal by its registry path', async () => {
    const rpc = saved()
    supabaseWith(rpc)
    const res = await put(page({ profile: { ...doc, display_time_zone: 'America/Phoenix' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'profile_malformed', errors: [{ path: 'display_time_zone' }] })
    expect(pageCalls(rpc)).toEqual([])

    supabaseWith(vi.fn(async () => ({ data: null, error: { code: 'BP422', message: 'display_time_zone_invalid', details: 'America/Phoenix' } })))
    const refused = await put(page())
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { errors: unknown[] }).errors).toEqual([
      { code: 'display_time_zone_invalid', path: 'displayTimeZone', field: 'profile.display_time_zone', message: 'America/Phoenix' },
    ])
  })

  it('P0002 from the function is 404, and a real database error is 500, never a false 404 or 409', async () => {
    supabaseWith(vi.fn(async () => ({ data: null, error: { code: 'P0002', message: 'partner_not_found' } })))
    expect((await put(page())).status).toBe(404)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith(vi.fn(async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })))
    expect((await put(page())).status).toBe(500)
  })

  it('clears the partner constants copy only when the patch touches a field it is built from', async () => {
    supabaseWith(saved())
    await put(page({ patch: { name: 'x' } }))
    expect(invalidatePartnerConstantsCache).not.toHaveBeenCalled()
    supabaseWith(saved())
    await put(page({ patch: { is_active: false } }))
    expect(invalidatePartnerConstantsCache).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['retiring the partner copy', 'retire'],
    ['clearing the partner constants copy', 'constants'],
    ['rebuilding the buyer profiles copy (throws)', 'profiles-throw'],
    ['rebuilding the buyer profiles copy (answers null)', 'profiles-null'],
  ] as const)('a committed save is 200 with stored_copy_warning when %s fails, and every step still runs once', async (_label, which) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = kvDouble()
    if (which === 'retire') kv.delete = async () => { throw new Error('kv unavailable') }
    if (which === 'constants') vi.mocked(invalidatePartnerConstantsCache).mockRejectedValueOnce(new Error('kv unavailable'))
    if (which === 'profiles-throw') vi.mocked(refreshBuyerProfilesCache).mockRejectedValueOnce(new Error('kv unavailable'))
    if (which === 'profiles-null') vi.mocked(refreshBuyerProfilesCache).mockResolvedValueOnce(null)
    supabaseWith(saved())
    const res = await put(page({ patch: { is_active: false } }), { SUPABASE_JWKS_URL: 'x', WORKFLOW_CACHE: kv } as unknown as Env)
    expect(res.status).toBe(200)
    const body = await res.json() as { partner_version: number; stored_copy_warning?: string }
    expect(body.partner_version).toBe(5)
    expect(body.stored_copy_warning).toBe(COPY_NOT_CLEARED_MESSAGE)
    expect(invalidatePartnerConstantsCache).toHaveBeenCalledTimes(1)
    expect(refreshBuyerProfilesCache).toHaveBeenCalledTimes(1)
  })
})
