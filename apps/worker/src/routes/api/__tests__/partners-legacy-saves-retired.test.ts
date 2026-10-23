/**
 * The two saves the partners page used before #2133 are retired (#2187).
 *
 * PUT /partners/:id/buyer-profile went seven UTC days with no call (its KV
 * counter, read 2026-10-23), and PUT /partners/:id, the partner only save of
 * #2132, is called by nothing the page sends since the same release. A tab
 * opened before that release still holds the old code, so each route answers
 * the 428 reload_required such a page already shows as its own sentence, rather
 * than a bare 404, and reads, writes and counts nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { RELOAD_REQUIRED_MESSAGE } from '../partners'
import { makeSupabase } from './_supabase-mock'
import api from '../index'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com', display_name: 'Dan Wright' }
const SAVE_ID = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'

/** Every call the route makes on the database, the user lookup jwtAuth needs left out. */
function recordingSupabase() {
  const touched: string[] = []
  const sb = makeSupabase(
    { users: { single: testUser }, partner_configs: { single: { id: 'p-1' } } },
    {
      rpc: async (name: string) => {
        touched.push(`rpc ${name}`)
        return { data: null, error: null }
      },
    },
  ) as unknown as { from: (t: string) => unknown; rpc: unknown }
  const from = sb.from.bind(sb)
  sb.from = (table: string) => {
    if (table !== 'users' && table !== 'user_allowlist') touched.push(`from ${table}`)
    return from(table)
  }
  return { sb, touched }
}

function kvRecording() {
  const touched: string[] = []
  return {
    touched,
    kv: {
      get: async (k: string) => { touched.push(`get ${k}`); return null },
      put: async (k: string) => { touched.push(`put ${k}`) },
      delete: async (k: string) => { touched.push(`delete ${k}`) },
    },
  }
}

describe('the saves the page used before #2133 are retired (#2187)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  })

  it.each([
    ['PUT /partners/:id/buyer-profile', '/partners/p-1/buyer-profile', { expected_version: 2, profile: { sold_on: 'offer', is_enabled: false } }],
    ['PUT /partners/:id, versioned as #2132 sent it', '/partners/p-1', { name: 'Renamed', expected_version: 4, save_id: SAVE_ID }],
    ['PUT /partners/:id, unversioned as before #2132', '/partners/p-1', { name: 'Renamed' }],
  ])('%s answers 428 reload_required with the sentence an old page shows, and reads, writes and counts nothing', async (_label, path, body) => {
    const { sb, touched } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const { kv, touched: kvTouched } = kvRecording()

    const res = await api.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify(body),
    }, { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: kv } as unknown as Env, recordingContext())

    expect(res.status).toBe(428)
    expect(await res.json()).toEqual({ error: 'reload_required', message: RELOAD_REQUIRED_MESSAGE })
    expect(touched).toEqual([])
    expect(kvTouched).toEqual([])
  })
})
