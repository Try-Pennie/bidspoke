/**
 * Service-presets routes — #320 (the false-404 class, 5697088).
 * PUT /:id must return a retryable 5xx when its lookup hits a real DB error,
 * and a 404 only for a genuinely missing preset.
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

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body ? JSON.stringify(body) : undefined },
    testEnv,
    mockCtx
  )
}

describe('PUT /service-presets/:id — DB error => 5xx, not 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 for a genuinely missing preset', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_presets: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/service-presets/missing', { name: 'X' })
    expect(res.status).toBe(404)
  })

  it('returns 5xx (not a false 404) when the lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_presets: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/service-presets/sp-1', { name: 'X' })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /service-presets/:id: zero-row + DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404, writes no audit log, and scopes the delete to the org when it matches zero rows', async () => {
    // #588: this route deletes without a prior existence read, so a zero-row
    // delete is the ONLY signal the preset was missing. It must become a 404, and
    // must not audit a delete that never landed.
    const mock = makeSupabase({
      users: { single: testUser },
      service_presets: { writeRows: [] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(mock as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await request(app, 'DELETE', '/service-presets/sp-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Preset not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    // The delete is org-scoped (application-level defense mirroring RLS).
    expect(mock.eqCalls['service_presets']).toContainEqual(['organization_id', 'org-abc'])
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_presets: { deleteError: { code: '42P01', message: 'relation missing' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/service-presets/sp-1')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
