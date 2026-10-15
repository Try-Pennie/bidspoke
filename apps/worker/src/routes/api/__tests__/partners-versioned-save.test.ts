/**
 * PUT /partners/:id is a versioned save that writes only the fields it names
 * (#2132, part of #2114).
 *
 * Before this the route wrote every field in the body, and the page sent the
 * whole form, so a save made on top of someone else's newer save put their
 * change back the way it was, silently. The route now requires the version the
 * page was edited from and a save id, calls save_partner_config with only the
 * keys in the body, and answers a stale version with 409 and the current row.
 * A committed save is never answered as an error: every cache step after the
 * commit is reported through copyCleared / copyWarning (L33).
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
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { COPY_NOT_CLEARED_MESSAGE } from '../../../lib/stored-copy'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com', display_name: 'Dan Wright' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const SAVE_ID = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'
const STORED = { id: 'p-1', organization_id: 'org-abc', name: 'SoFi', slug: 'sofi', bid_mode: 'ping_only', is_active: true, click_url: null, cf_secret_key: null, version: 4 }

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

type Rpc = ReturnType<typeof vi.fn>

function supabaseWith(rpc: Rpc, ownership: Record<string, unknown> | null = { id: 'p-1', click_url: null }) {
  return makeSupabase(
    { users: { single: testUser }, partner_configs: { single: ownership } },
    { rpc: rpc as unknown as (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  ) as unknown as ReturnType<typeof createSupabaseClient>
}

/** A KV double whose every call can be made to throw, and which records what it was asked. */
function kvDouble(opts: { failing?: boolean } = {}) {
  const calls: string[] = []
  const fail = () => { if (opts.failing) throw new Error('kv unavailable') }
  return {
    calls,
    kv: {
      delete: async (k: string) => { calls.push(`delete ${k}`); fail() },
      put: async (k: string) => { calls.push(`put ${k}`); fail() },
      get: async () => { fail(); return null },
    },
  }
}

describe('PUT /partners/:id: versioned save of only the named fields (#2132)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({} as Awaited<ReturnType<typeof refreshBuyerProfilesCache>>)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  function put(body: unknown, env: Env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: kvDouble().kv } as unknown as Env) {
    return app.request('/partners/p-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify(body),
    }, env, mockCtx)
  }

  const saved = (over: Record<string, unknown> = {}) => vi.fn(async (name: string, _args?: unknown) =>
    name === 'save_partner_config' ? { data: { ...STORED, version: 5, ...over }, error: null } : { data: null, error: null })

  it('answers 428 reload_required, and reads and writes nothing, when the page sends no expected_version', async () => {
    const rpc = saved()
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    const res = await put({ name: 'Renamed', save_id: SAVE_ID })
    expect(res.status).toBe(428)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('reload_required')
    expect(body.message).toBe('This page was opened before an update to how partners are saved, so this save was not made. Your changes are still on screen. Copy them and reload. A release can take a few minutes to reach your browser, so if this message comes back after reloading, wait a few minutes and try again.')
    expect(rpc.mock.calls.filter(([n]) => n === 'save_partner_config')).toEqual([])
  })

  it('answers 428 when the page sends no save_id', async () => {
    const rpc = saved()
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    const res = await put({ name: 'Renamed', expected_version: 4 })
    expect(res.status).toBe(428)
    expect(rpc.mock.calls.filter(([n]) => n === 'save_partner_config')).toEqual([])
  })

  it('refuses a malformed expected_version or save_id with 400, a different cause from a stale page', async () => {
    for (const body of [{ expected_version: -1, save_id: SAVE_ID }, { expected_version: '4', save_id: SAVE_ID }, { expected_version: 1.5, save_id: SAVE_ID }, { expected_version: 4, save_id: 'not-a-uuid' }]) {
      const rpc = saved()
      vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
      const res = await put({ name: 'Renamed', ...body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(rpc.mock.calls.filter(([n]) => n === 'save_partner_config')).toEqual([])
    }
  })

  it('calls save_partner_config with the org, the version, the save id, the actor and ONLY the keys in the body', async () => {
    const rpc = saved({ name: 'Renamed' })
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    const res = await put({ name: 'Renamed', daily_cap: null, expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(200)
    const call = rpc.mock.calls.find(([n]) => n === 'save_partner_config')
    expect(call?.[1]).toEqual({
      p_org: 'org-abc',
      p_id: 'p-1',
      p_expected_version: 4,
      p_patch: { name: 'Renamed', daily_cap: null },
      p_save_id: SAVE_ID,
      p_actor: 'user-1',
      p_actor_email: 'dan@pennie.com',
      p_actor_name: 'Dan Wright',
    })
    expect(await res.json()).toMatchObject({ name: 'Renamed', version: 5, credential_warning: null })
  })

  it('a body that omits bid_mode never sends it, so the stored ping_only stays exactly as it was', async () => {
    const rpc = saved()
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    await put({ name: 'Renamed', expected_version: 4, save_id: SAVE_ID })
    const patch = (rpc.mock.calls.find(([n]) => n === 'save_partner_config')?.[1] as { p_patch: Record<string, unknown> }).p_patch
    expect('bid_mode' in patch).toBe(false)
    expect(Object.keys(patch)).toEqual(['name'])
  })

  it('answers a stale version with 409, the current row, its save id and its last editor, and does no cache work', async () => {
    const detail = { current: { ...STORED, name: 'SoFi (theirs)', version: 6 }, last_save_id: 'f0f0f0f0-0000-4000-8000-000000000001', changed_by_name: 'Brian Nelms', changed_at: '2026-10-15T14:02:00Z' }
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify(detail) } }))
    const { kv, calls } = kvDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    const res = await put({ name: 'Mine', expected_version: 4, save_id: SAVE_ID }, { SUPABASE_JWKS_URL: 'x', WORKFLOW_CACHE: kv } as unknown as Env)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stale_version', ...detail })
    expect(calls).toEqual([])
    expect(invalidatePartnerConstantsCache).not.toHaveBeenCalled()
    expect(refreshBuyerProfilesCache).not.toHaveBeenCalled()
  })

  it('answers 404 for another organization\'s partner, whether the ownership read or the function finds nothing', async () => {
    const rpc = saved()
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc, null))
    expect((await put({ name: 'x', expected_version: 4, save_id: SAVE_ID })).status).toBe(404)
    expect(rpc.mock.calls.filter(([n]) => n === 'save_partner_config')).toEqual([])

    const notFound = vi.fn(async () => ({ data: null, error: { code: 'P0002', message: 'partner_not_found' } }))
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(notFound))
    expect((await put({ name: 'x', expected_version: 4, save_id: SAVE_ID })).status).toBe(404)
  })

  it('answers 400 naming a field the save may not write', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP422', message: 'field_not_editable', details: 'slug' } }))
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    const res = await put({ slug: 'stolen', expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'field_not_editable', field: 'slug' })
  })

  it('a real database error is still a 500, never a false 404 or 409', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }))
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(rpc))
    expect((await put({ name: 'x', expected_version: 4, save_id: SAVE_ID })).status).toBe(500)
  })

  // A1: every step after the commit is reported, and none turns the committed
  // save into an error.
  it.each([
    ['retiring the partner copy', 'retire'],
    ['clearing the partner constants copy', 'constants'],
    ['rebuilding the buyer profiles copy (throws)', 'profiles-throw'],
    ['rebuilding the buyer profiles copy (answers null)', 'profiles-null'],
  ] as const)('a committed save is 200 with stored_copy_warning when %s fails', async (_label, which) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = kvDouble()
    if (which === 'retire') kv.delete = async () => { throw new Error('kv unavailable') }
    if (which === 'constants') vi.mocked(invalidatePartnerConstantsCache).mockRejectedValueOnce(new Error('kv unavailable'))
    if (which === 'profiles-throw') vi.mocked(refreshBuyerProfilesCache).mockRejectedValueOnce(new Error('kv unavailable'))
    if (which === 'profiles-null') vi.mocked(refreshBuyerProfilesCache).mockResolvedValueOnce(null)
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(saved({ is_active: false })))
    const res = await put({ is_active: false, expected_version: 4, save_id: SAVE_ID }, { SUPABASE_JWKS_URL: 'x', WORKFLOW_CACHE: kv } as unknown as Env)
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number; stored_copy_warning?: string }
    expect(body.version).toBe(5)
    expect(body.stored_copy_warning).toBe(COPY_NOT_CLEARED_MESSAGE)
    // Every step still ran: one failing never skips the others.
    expect(invalidatePartnerConstantsCache).toHaveBeenCalledTimes(1)
    expect(refreshBuyerProfilesCache).toHaveBeenCalledTimes(1)
  })

  it('with every KV write failing, the committed save still answers 200 with stored_copy_warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = kvDouble({ failing: true })
    vi.mocked(invalidatePartnerConstantsCache).mockRejectedValueOnce(new Error('kv unavailable'))
    vi.mocked(refreshBuyerProfilesCache).mockResolvedValueOnce(null)
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(saved({ is_active: false })))
    const res = await put({ is_active: false, expected_version: 4, save_id: SAVE_ID }, { SUPABASE_JWKS_URL: 'x', WORKFLOW_CACHE: kv } as unknown as Env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { stored_copy_warning?: string }).stored_copy_warning).toBe(COPY_NOT_CLEARED_MESSAGE)
  })

  it('a clean save carries no warning', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(supabaseWith(saved({ is_active: false })))
    const res = await put({ is_active: false, expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(200)
    expect('stored_copy_warning' in ((await res.json()) as object)).toBe(false)
  })
})
