/**
 * Env var folder routes: #595 (the false-404 write class).
 * PATCH /:id ends its write in .update().select().single(). PostgREST answers a
 * zero-row match there with PGRST116, which must become a 404, not a 500. The
 * cycle-trigger branch runs before the not-found check and must still return 400,
 * and a genuine DB error must still surface as a retryable 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
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
const mockCtx = recordingContext()

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function patch(app: { request: Function }, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
    testEnv,
    mockCtx
  )
}

describe('PATCH /env-folders/:id: zero-row 404, cycle 400, real DB error 500 (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const existing = { id: 'f-1', name: 'Old', parent_id: null }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 (not 500) and skips the audit log when the update matches zero rows', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        env_var_folders: [{ single: existing }, { single: null }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/env-folders/f-1', { name: 'New' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'folder not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 400 when the cycle trigger fires (this branch runs before the not-found check)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        env_var_folders: [{ single: existing }, { updateError: { message: 'folder cycle detected' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/env-folders/f-1', { parent_id: null, name: 'New' })
    expect(res.status).toBe(400)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        env_var_folders: [{ single: existing }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/env-folders/f-1', { name: 'New' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated row on the happy path', async () => {
    const updated = { id: 'f-1', organization_id: 'org-abc', parent_id: null, name: 'New', created_at: 't', updated_at: 't' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        env_var_folders: [{ single: existing }, { updateResult: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/env-folders/f-1', { name: 'New' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updated)
  })
})
