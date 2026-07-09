/**
 * Partner-bid-config routes — #320 (false-404 class, 5697088 + #319).
 * GET /:id and DELETE /:id must return a retryable 5xx when the
 * partner_bid_configs lookup hits a real DB error, and 404 only for a missing config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
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

describe('Partner-bid-config routes — DB error => 5xx, not 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('GET /:id returns 404 for a genuinely missing config', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_bid_configs: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/partner-bid-configs/missing')
    expect(res.status).toBe(404)
  })

  it('GET /:id returns 5xx (not a false 404) when the lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_bid_configs: { singleError: DB_ERROR } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/partner-bid-configs/c-1')
    expect(res.status).toBe(500)
  })

  it('DELETE /:id returns 5xx (not a false 404) when the existence lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_bid_configs: { singleError: DB_ERROR } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-bid-configs/c-1')
    expect(res.status).toBe(500)
  })
})

describe('DELETE /partner-bid-configs/:id: zero-row + write DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 and writes no audit log when the delete matches zero rows', async () => {
    // #588: existence read passes but the DELETE touches nothing, so the 200 that
    // PostgREST implies must become a 404 and skip the audit line.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_bid_configs: [{ single: { slug: 's', name: 'n' } }, { writeRows: [] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-bid-configs/c-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Config not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete write hits a real DB error', async () => {
    // Distinct from the existing existence-lookup error test: here the lookup
    // succeeds and the write itself fails, which still must be a 500, not a 404.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_bid_configs: [{ single: { slug: 's', name: 'n' } }, { deleteError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-bid-configs/c-1')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
