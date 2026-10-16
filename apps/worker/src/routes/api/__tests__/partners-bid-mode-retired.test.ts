/**
 * The partner routes no longer write partner_configs.bid_mode (#2182, the
 * contract step after PM-9, part of #2114).
 *
 * Nothing acts on bid_mode, and its column is dropped in a later migration
 * (docs/adr/0007). Before that drop a deployed Worker must neither send nor
 * store it: a create no longer names it (the column default applies until the
 * column goes), and a create, a save or a page save that names it is refused
 * by name before anything is read or written. Without the refusal, a save
 * naming it would reach save_partner_config, whose editable list still holds
 * it, and be stored; after the drop the same save would fail on a missing
 * column as a server error instead of a refusal.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com', display_name: 'Dan Wright' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env
const SAVE_ID = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'
const RETIRED_MESSAGE = 'bid_mode is retired: nothing reads it, and its column was removed (#2182). Send the save without it.'

// The route tree is imported once, before the tests, so its cold import is not
// charged to whichever test runs first.
let api: Awaited<typeof import('../index')>['default']
beforeAll(async () => { api = (await import('../index')).default }, 60_000)

function call(method: 'POST' | 'PUT', route: string, body: unknown) {
  return api.request(route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) }, env, mockCtx)
}

function supabase(rpcData: unknown = null) {
  const insertResult = { id: 'p-new' }
  const rpc = vi.fn(async (_name: string, _args?: unknown) => ({ data: rpcData, error: null }))
  const sb = makeSupabase(
    { users: { single: testUser }, partner_configs: { single: { id: 'p-1', click_url: null, accept_signals: [], external_routing_code: null }, insertResult } },
    { rpc: rpc as unknown as (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  )
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return { sb, rpc }
}

const partnerCalls = (sb: ReturnType<typeof makeSupabase>) => sb.calls['partner_configs'] ?? []

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({} as Awaited<ReturnType<typeof refreshBuyerProfilesCache>>)
  vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
})

describe('bid_mode is no longer written by any partner route (#2182)', () => {
  it('POST creates a partner without naming bid_mode, so the column default applies until the column goes', async () => {
    const { sb } = supabase()
    const res = await call('POST', '/partners', { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(201)
    const insert = partnerCalls(sb).find(([m]) => m === 'insert')
    expect(insert).toBeDefined()
    const row = (insert![1] as unknown[])[0] as Record<string, unknown>
    expect(row.name).toBe('Acme')
    expect('bid_mode' in row).toBe(false)
  })

  it('POST naming bid_mode is refused by name with 400, and nothing is inserted', async () => {
    const { sb } = supabase()
    const res = await call('POST', '/partners', { name: 'Acme', slug: 'acme', bid_mode: 'ping_only' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'field_not_editable', field: 'bid_mode', message: RETIRED_MESSAGE })
    expect(partnerCalls(sb).filter(([m]) => m === 'insert')).toEqual([])
  })

  it('PUT naming bid_mode is refused by name with 400, as the function refuses a field it may not write, and nothing is read or saved', async () => {
    const { sb, rpc } = supabase()
    const res = await call('PUT', '/partners/p-1', { name: 'Renamed', bid_mode: 'commit', expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'field_not_editable', field: 'bid_mode', message: RETIRED_MESSAGE })
    expect(rpc).not.toHaveBeenCalled()
    expect(partnerCalls(sb)).toEqual([])
  })

  it('PUT /page with bid_mode in its patch is refused by name with 422 on that field, and nothing is read or saved', async () => {
    const { sb, rpc } = supabase()
    const res = await call('PUT', '/partners/p-1/page', { expected_partner_version: 4, patch: { name: 'Renamed', bid_mode: 'ping_only' }, save_id: SAVE_ID })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'field_not_editable',
      message: RETIRED_MESSAGE,
      errors: [{ code: 'field_not_editable', path: 'bid_mode', field: 'bid_mode', message: RETIRED_MESSAGE }],
    })
    expect(rpc).not.toHaveBeenCalled()
    expect(partnerCalls(sb)).toEqual([])
  })

  it('a save that does not name bid_mode is unaffected', async () => {
    const { rpc } = supabase({ id: 'p-1', name: 'Renamed', version: 5 })
    const res = await call('PUT', '/partners/p-1', { name: 'Renamed', expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(200)
    expect(rpc.mock.calls[0]?.[0]).toBe('save_partner_config')
  })
})
