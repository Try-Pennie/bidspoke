/**
 * POST /api/admin/seal-slack-token (#2331): what only the route decides. The
 * seal and its verification are covered in slack-token-seal.test.ts.
 *
 * Who may call it: any signed in user (every /api/admin route takes any signed
 * in user's JWT). Whose data: only the caller's organization, which the route
 * takes from the verified token and never from the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/secret-reencrypt')
vi.mock('../slack-token-seal')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { reencryptSecrets } from '../../../lib/secret-reencrypt'
import { sealSlackTokens } from '../slack-token-seal'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@trypennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@trypennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', SECRET_ENCRYPTION_KEY: KEY } as unknown as Env

const RESULT = { dryRun: true, rotating: false, rowsSeen: 1, sealed: 1, alreadySealed: 0, cannotSeal: [], changedMeanwhile: [], verification: [], readyForContract: false }

async function post(path: string, body: unknown) {
  const { default: api } = await import('../index')
  return api.request(path, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env, recordingContext())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(createSupabaseClient).mockReturnValue({
    from: () => ({}),
    rpc: (name: string) => Promise.resolve(name === 'auth_user_with_allowlist' ? { data: [{ ...testUser, allowed: true }], error: null } : { data: [], error: null }),
  } as unknown as ReturnType<typeof createSupabaseClient>)
  vi.mocked(sealSlackTokens).mockImplementation(async (_s, _k, _o, _a, o) => ({ ...RESULT, dryRun: o.dryRun }))
})

describe('POST /api/admin/seal-slack-token', () => {
  it('is a preview unless dryRun is false, scoped to the caller org and naming the caller', async () => {
    const res = await post('/admin/seal-slack-token', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dryRun: true })
    expect(vi.mocked(sealSlackTokens)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ encryptWith: KEY }), 'org-abc', 'user-1', { dryRun: true })
  })

  it('runs when dryRun is false', async () => {
    await post('/admin/seal-slack-token', { dryRun: false })
    expect(vi.mocked(sealSlackTokens).mock.calls[0][4]).toEqual({ dryRun: false })
  })

  it('refuses a dryRun that is not a boolean rather than reading it as truthy', async () => {
    const res = await post('/admin/seal-slack-token', { dryRun: 'no' })
    expect(res.status).toBe(400)
    expect(vi.mocked(sealSlackTokens)).not.toHaveBeenCalled()
  })

  it('answers 500 with the reason when the seal throws', async () => {
    vi.mocked(sealSlackTokens).mockRejectedValue(new Error('reading service_connections failed: boom'))
    const res = await post('/admin/seal-slack-token', { dryRun: false })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: expect.stringContaining('boom') })
  })
})

describe('POST /api/admin/reencrypt-secrets names its caller for the service_connections audit', () => {
  it('passes the caller as the actor', async () => {
    vi.mocked(reencryptSecrets).mockResolvedValue({ dryRun: false, ok: true, tables: [] })
    await post('/admin/reencrypt-secrets', { dryRun: false })
    expect(vi.mocked(reencryptSecrets).mock.calls[0][2]).toEqual({ dryRun: false, actorId: 'user-1' })
  })
})
