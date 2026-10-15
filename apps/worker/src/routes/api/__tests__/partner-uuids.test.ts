/**
 * Partner-UUID routes.
 *
 * #2135: both writes go through change_partner_uuid, which sets
 * bidspoke.actor_* before writing, so the partner_uuid_map triggers that send
 * the partners page notice can tell an editor's change from a hand run SQL one.
 * What the trigger sees is proved in supabase/tests/partner_page_notice.test.sql
 * (case 14); here, that the route sends the actor and keeps to its organization.
 *
 * #2141: the audit row (#105) is written by the partner_uuid_map_audit trigger
 * from that same actor, exactly once (supabase/tests/partner_history_audit.test.sql
 * case 1), so the route writes none of its own: a route write as well would
 * record each change twice.
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
import { makeSupabase, type TableConfig } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com', display_name: 'Dan Wright' }
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

type RpcResult = { data: unknown; error: unknown }

function wire(rpcResult: RpcResult, tables: Record<string, TableConfig> = {}) {
  const rpc = vi.fn(async (_name: string, _args: unknown): Promise<RpcResult> => rpcResult)
  const supabase = makeSupabase({ users: { single: testUser }, ...tables }, { rpc })
  vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
  return { rpc, supabase }
}

const ROW = { id: 'pu-9', org_id: USER_ORG, partner_slug: 'tripoint', uuid: 'u-1', created_at: '2026-10-15T00:00:00Z' }

describe('POST /partner-uuids', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('adds through change_partner_uuid with the actor, so the trigger sees who made it (#2135)', async () => {
    const { rpc } = wire({ data: ROW, error: null })
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(ROW)
    expect(rpc).toHaveBeenCalledWith('change_partner_uuid', {
      p_org: USER_ORG, p_slug: 'tripoint', p_uuid: 'u-1', p_action: 'add',
      p_actor: 'user-1', p_actor_email: 'dan@pennie.com', p_actor_name: 'Dan Wright',
    })
  })

  it('leaves the audit row to the trigger, so a create is recorded once (#2141)', async () => {
    const { supabase } = wire({ data: ROW, error: null })
    await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(supabase.calls['audit_log']).toBeUndefined()
    expect(vi.mocked(invalidatePartnerConstantsCache)).toHaveBeenCalledWith(USER_ORG, expect.anything())
  })

  it('answers 404 for a slug no partner of this organization holds, and writes nothing else', async () => {
    wire({ data: null, error: { code: 'P0002', message: 'partner_not_found', details: 'other-org-slug' } })
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'other-org-slug', uuid: 'u-1' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'No partner with slug "other-org-slug" in this organization' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('answers 409 for a sub-account ID already mapped', async () => {
    wire({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'UUID "u-1" already exists' })
  })

  it('answers 500 for a real database failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ data: null, error: { code: '42P01', message: 'relation missing' } })
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('refuses a body without both fields before any write', async () => {
    const { rpc } = wire({ data: ROW, error: null })
    expect((await request(app, 'POST', '/partner-uuids', { body: { uuid: 'u-1' } })).status).toBe(400)
    expect((await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint' } })).status).toBe(400)
    expect(rpc.mock.calls.filter(([n]) => n === 'change_partner_uuid')).toHaveLength(0)
  })
})

describe('DELETE /partner-uuids/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('removes the mapping it found in this organization through change_partner_uuid (#2135)', async () => {
    const { rpc, supabase } = wire({ data: ROW, error: null }, { partner_uuid_map: { single: ROW } })
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(200)
    expect(supabase.eqCalls['partner_uuid_map']).toEqual([['id', 'pu-9'], ['org_id', USER_ORG]])
    expect(rpc).toHaveBeenCalledWith('change_partner_uuid', {
      p_org: USER_ORG, p_slug: 'tripoint', p_uuid: 'u-1', p_action: 'remove',
      p_actor: 'user-1', p_actor_email: 'dan@pennie.com', p_actor_name: 'Dan Wright',
    })
    // The trigger records the removal, once (#2141).
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(supabase.calls['audit_log']).toBeUndefined()
  })

  // #588: a delete of an id that never existed, or another organization's, must
  // not read as a deletion.
  it('answers 404 when this organization holds no such mapping, and does not audit or invalidate', async () => {
    const { rpc } = wire({ data: ROW, error: null }, { partner_uuid_map: { single: null } })
    const res = await request(app, 'DELETE', '/partner-uuids/pu-gone')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner UUID not found' })
    expect(rpc.mock.calls.filter(([n]) => n === 'change_partner_uuid')).toHaveLength(0)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('answers 404 when the mapping went between the read and the remove', async () => {
    wire({ data: null, error: { code: 'P0002', message: 'uuid_not_found', details: 'u-1' } }, { partner_uuid_map: { single: ROW } })
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(404)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  // #303: a real database failure stays a 500, never a 404.
  it('answers 500 when the read fails for a real database reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ data: ROW, error: null }, { partner_uuid_map: { singleError: { code: '42P01', message: 'relation missing' } } })
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
