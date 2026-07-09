/**
 * Partner-UUID routes (#105): create and delete must write audit rows with
 * entity_type 'partner_uuid' and the real row id (previously not audited at all).
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

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(app: { request: Function }, method: string, path: string, opts: { body?: unknown } = {}) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, testEnv, mockCtx)
}

describe('partner-uuids audit (#105)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('audits create as partner_uuid with the new row id', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_uuid_map: { insertResult: { id: 'pu-9', partner_slug: 'tripoint', uuid: 'u-1' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(res.status).toBe(201)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'partner_uuid', 'pu-9', 'created', 'user-1', expect.anything()
    )
  })

  it('audits delete as partner_uuid with the row id', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_uuid_map: { writeRows: [{ id: 'pu-9' }] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'partner_uuid', 'pu-9', 'deleted', 'user-1'
    )
  })
})

// This handler never looked the row up before deleting it, so a delete of an id
// that never existed (or that belongs to another org) was indistinguishable from
// a real one: 200 {ok:true}, plus an audit row claiming a deletion happened.
describe('partner-uuids zero-row delete (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when the delete matches no row, and does not audit or invalidate', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_uuid_map: { writeRows: [] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-uuids/pu-gone')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner UUID not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('scopes the delete to the caller org so another org row reads as not found', async () => {
    const supabase = makeSupabase({ users: { single: testUser }, partner_uuid_map: { writeRows: [] } })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
    await request(app, 'DELETE', '/partner-uuids/pu-other-org')
    expect(supabase.eqCalls['partner_uuid_map']).toEqual([
      ['id', 'pu-other-org'],
      ['org_id', USER_ORG],
    ])
  })

  // A real database failure must stay a 500. Reporting it as 404 would tell the
  // dashboard the row is gone when it may still be there (#303).
  it('returns 500, not 404, when the delete fails for a real database reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_uuid_map: { deleteError: { code: '42P01', message: 'relation missing' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
