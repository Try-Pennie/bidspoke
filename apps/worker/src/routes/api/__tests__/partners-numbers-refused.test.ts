/**
 * The partner routes refuse a number the partner record cannot hold (#2328):
 * a fractional or out of range daily attempt cap, error count, confirmation
 * window, routing code or rule status, through the one shared rule the partners
 * page applies first (partnerNumberErrors). Each refusal names its field, and
 * nothing is read or written, so a stale or hand made client cannot store 2.5
 * where the engine counts whole attempts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
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
const mockCtx = recordingContext()
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env
const SAVE_ID = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'

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

const CAP_MESSAGE = 'Daily attempt cap is a whole number, 1 or more.'

describe('partner numbers are refused by the shared rule (#2328)', () => {
  it('POST with a fractional daily attempt cap is refused with 422 naming it, and nothing is inserted', async () => {
    const { sb } = supabase()
    const res = await call('POST', '/partners', { name: 'Acme', slug: 'acme', daily_cap: 2.5 })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'partner_number_invalid',
      message: CAP_MESSAGE,
      errors: [{ code: 'partner_number_invalid', path: 'daily_cap', field: 'daily_cap', message: CAP_MESSAGE }],
    })
    expect(partnerCalls(sb).filter(([m]) => m === 'insert')).toEqual([])
  })

  it('PUT with a zero error count is refused with 422, and nothing is read or saved', async () => {
    const { sb, rpc } = supabase()
    const res = await call('PUT', '/partners/p-1', { name: 'Renamed', circuit_error_threshold: 0, expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(422)
    expect((await res.json() as { errors: { field: string }[] }).errors.map((e) => e.field)).toEqual(['circuit_error_threshold'])
    expect(rpc).not.toHaveBeenCalled()
    expect(partnerCalls(sb)).toEqual([])
  })

  it('PUT /page with a routing code out of range in its patch is refused with 422 on that field, and nothing is read or saved', async () => {
    const { sb, rpc } = supabase()
    const res = await call('PUT', '/partners/p-1/page', { expected_partner_version: 4, patch: { external_routing_code: 40000 }, save_id: SAVE_ID })
    expect(res.status).toBe(422)
    expect((await res.json() as { errors: { field: string }[] }).errors.map((e) => e.field)).toEqual(['external_routing_code'])
    expect(rpc).not.toHaveBeenCalled()
    expect(partnerCalls(sb)).toEqual([])
  })

  it('whole numbers in range save as before', async () => {
    const { rpc } = supabase({ id: 'p-1', name: 'Renamed', version: 5 })
    const res = await call('PUT', '/partners/p-1', { name: 'Renamed', daily_cap: 250, circuit_error_threshold: 5, expected_version: 4, save_id: SAVE_ID })
    expect(res.status).toBe(200)
    expect(rpc.mock.calls[0]?.[0]).toBe('save_partner_config')
  })
})
