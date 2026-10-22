/**
 * HTTP Services presets are retired (#2338, build PR 14; Dan's decision 2 of
 * 2026-10-21). Production held none (service_presets had 0 rows, measured
 * 2026-10-21) and no workflow named one; the Webhook step keeps its built in
 * services, which live in code. So /api/service-presets answers as any path
 * the Worker does not serve, and nothing reads or writes the table.
 *
 * The table itself is left in place (expand/contract, docs/adr/0007): it is
 * dropped in a later release, #2638.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'
import api from '../index'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
})

describe('/api/service-presets is retired (#2338)', () => {
  it('every method answers 404, and the service_presets table is never touched', async () => {
    const client = makeSupabase({ users: { single: testUser }, service_presets: { list: [{ id: 'sp-1' }], single: { id: 'sp-1' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as unknown as ReturnType<typeof createSupabaseClient>)
    for (const [method, route] of [['GET', '/service-presets'], ['POST', '/service-presets'], ['PUT', '/service-presets/sp-1'], ['DELETE', '/service-presets/sp-1']] as const) {
      const res = await api.request(route, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
        body: method === 'POST' || method === 'PUT' ? JSON.stringify({ name: 'X', slug: 'x', auth_type: 'none' }) : undefined,
      }, testEnv, recordingContext())
      expect(res.status, `${method} ${route}`).toBe(404)
    }
    expect(client.calls.service_presets ?? []).toEqual([])
  })

})
