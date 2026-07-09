/**
 * Partner routes — #320 (the false-404 class, 5697088).
 * GET /:id and GET /:id/cap-count must return a retryable 5xx when the
 * partner_configs lookup hits a real DB error, and 404 only for a missing partner.
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
  })
})

describe('DELETE /partners/:id: zero-row + DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 and writes no audit log when the delete matches zero rows', async () => {
    // #588: the existence read succeeds but the DELETE touches nothing (the row
    // raced away or is another org's). Auditing it would log a delete that never
    // happened.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { slug: 'sofi', name: 'SoFi' } }, { writeRows: [] }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Partner not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    // A transient write failure must surface as a retryable 500, never a 404.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_configs: [{ single: { slug: 'sofi', name: 'SoFi' } }, { deleteError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partners/p-1')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
