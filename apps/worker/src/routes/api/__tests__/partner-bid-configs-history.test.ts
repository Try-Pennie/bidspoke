/**
 * What the matrix config routes record for the partners page History (#2141).
 *
 * POST /partner-bid-configs/:id/sync credits the person who pressed Sync now:
 * it hands their users id to syncBidConfig, which writes it to
 * bid_config_history.changed_by. Creating, updating and deleting a config
 * write an audit row carrying the partner it belongs to, so a deleted config's
 * rows still reach that partner's History once the config id no longer
 * resolves to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/bid-matrix-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/bid-matrix-sync')>()),
  syncBidConfig: vi.fn(),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { syncBidConfig } from '../../../lib/bid-matrix-sync'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
const mockCtx = recordingContext()

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function send(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, testEnv, mockCtx)
}

describe('matrix config routes record who and which partner (#2141)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('Sync now hands the presser to syncBidConfig', async () => {
    const supabase = makeSupabase({ users: { single: testUser }, partner_bid_configs: { single: { id: 'c-1' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
    vi.mocked(syncBidConfig).mockResolvedValue({ config_id: 'c-1' } as Awaited<ReturnType<typeof syncBidConfig>>)
    const res = await send(app, 'POST', '/partner-bid-configs/c-1/sync')
    expect(res.status).toBe(200)
    expect(vi.mocked(syncBidConfig)).toHaveBeenCalledWith('c-1', testEnv, supabase, 'user-1')
    // The config is this organization's before anything syncs.
    expect(supabase.eqCalls['partner_bid_configs']).toEqual([['id', 'c-1'], ['organization_id', 'org-abc']])
  })

  it('a created config is audited with its partner', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({
      users: { single: testUser },
      partner_bid_configs: { insertResult: { id: 'c-9' } },
    }) as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await send(app, 'POST', '/partner-bid-configs', { partner_id: 'p-1', slug: 'sofi', name: 'SoFi' })
    expect(res.status).toBe(201)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'partner_bid_config', 'c-9', 'created', 'user-1',
      { slug: 'sofi', name: 'SoFi', partner_id: 'p-1' })
  })

  it('an updated config is audited with its partner, so the row outlives the config', async () => {
    const supabase = makeSupabase({
      users: { single: testUser },
      partner_bid_configs: [{ single: { id: 'c-1', partner_id: 'p-1' } }, { updateResult: { id: 'c-1', name: 'Renamed' } }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await send(app, 'PUT', '/partner-bid-configs/c-1', { name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(supabase.calls['partner_bid_configs']).toContainEqual(['select', ['id, partner_id']])
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'partner_bid_config', 'c-1', 'updated', 'user-1',
      { changed_fields: ['name'], partner_id: 'p-1' })
  })

  it('a deleted config is audited with its partner', async () => {
    const supabase = makeSupabase({
      users: { single: testUser },
      partner_bid_configs: [{ single: { slug: 'sofi', name: 'SoFi', partner_id: 'p-1' } }, { writeRows: [{ id: 'c-1' }] }],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await send(app, 'DELETE', '/partner-bid-configs/c-1')
    expect(res.status).toBe(200)
    // The double hands back whatever row it holds, so the read must ASK for the partner.
    expect(supabase.calls['partner_bid_configs']).toContainEqual(['select', ['slug, name, partner_id']])
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'partner_bid_config', 'c-1', 'deleted', 'user-1',
      { slug: 'sofi', name: 'SoFi', partner_id: 'p-1' })
  })
})
