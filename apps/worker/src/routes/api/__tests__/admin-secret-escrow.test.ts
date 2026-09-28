/**
 * POST /api/admin/reencrypt-secrets and POST /api/admin/escrow-pepper (#384).
 *
 * The re-lock and the sealing are covered against their inputs in
 * lib/__tests__/secret-reencrypt.test.ts and lib/__tests__/pepper-escrow.test.ts.
 * What is covered here is what only the routes decide: the preview default, the
 * single use of the pepper handover, and what is written down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/secret-reencrypt')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { reencryptSecrets } from '../../../lib/secret-reencrypt'
import { PEPPER_ESCROW_CANARY } from '../../../lib/pepper-escrow'
import { hashSsn } from '../../../engine/persons-crypto'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@trypennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@trypennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function kv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  }
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    SECRET_ENCRYPTION_KEY: 'primary-key',
    SSN_HASH_PEPPER: 'the-pepper',
    IDEMPOTENCY: kv(),
    ...overrides,
  } as unknown as Env
}

const RESULT = {
  dryRun: true,
  ok: true,
  tables: [{ table: 'environment_variables', checked: 2, alreadyCurrent: 0, relocked: 2, undecryptable: [], changedMeanwhile: [] }],
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: { request: Function }, path: string, body: unknown, e: Env) {
  return app.request(
    path,
    { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    e,
    mockCtx,
  )
}

describe('admin secret escrow routes', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({}),
      rpc: (name: string) =>
        Promise.resolve(
          name === 'auth_user_with_allowlist' ? { data: [{ ...testUser, allowed: true }], error: null } : { data: [], error: null },
        ),
    } as unknown as ReturnType<typeof createSupabaseClient>)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(reencryptSecrets).mockImplementation(async (_s, _k, o) => ({ ...RESULT, dryRun: o.dryRun }) as never)
    app = await makeApp()
  })

  describe('POST /admin/reencrypt-secrets', () => {
    it('previews unless told otherwise, and writes no audit row for a preview', async () => {
      const res = await post(app, '/admin/reencrypt-secrets', {}, env({ SECRET_ENCRYPTION_KEY_NEXT: 'next-key' }))
      expect(res.status).toBe(200)
      expect(vi.mocked(reencryptSecrets).mock.calls[0][2]).toEqual({ dryRun: true })
      expect(((await res.json()) as { rotating: boolean }).rotating).toBe(true)
      expect(writeAuditLog).not.toHaveBeenCalled()
    })

    it('re-locks with the next key when told to, and records the counts', async () => {
      const res = await post(app, '/admin/reencrypt-secrets', { dryRun: false }, env({ SECRET_ENCRYPTION_KEY_NEXT: 'next-key' }))
      expect(res.status).toBe(200)
      const [, keys, opts] = vi.mocked(reencryptSecrets).mock.calls[0]
      expect(keys).toEqual({ encryptWith: 'next-key', decryptWith: ['next-key', 'primary-key'] })
      expect(opts).toEqual({ dryRun: false })
      const audit = vi.mocked(writeAuditLog).mock.calls[0]
      expect(audit[4]).toBe('secrets_reencrypted')
      expect(JSON.stringify(audit)).not.toContain('next-key')
    })

    it('refuses a dryRun that is not a boolean rather than guessing', async () => {
      const res = await post(app, '/admin/reencrypt-secrets', { dryRun: 'false' }, env())
      expect(res.status).toBe(400)
      expect(reencryptSecrets).not.toHaveBeenCalled()
    })

    it('answers 500 with the reason when the re-lock fails, never a success', async () => {
      vi.mocked(reencryptSecrets).mockRejectedValue(new Error('reading environment_variables failed: boom'))
      const res = await post(app, '/admin/reencrypt-secrets', { dryRun: false }, env())
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toMatch(/boom/)
    })
  })

  describe('POST /admin/escrow-pepper', () => {
    it('returns the sealed pepper and its canary hash, never the pepper itself', async () => {
      const res = await post(app, '/admin/escrow-pepper', {}, env())
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain('the-pepper')
      const body = JSON.parse(text) as { ciphertext: string; canaryHash: string }
      expect(body.canaryHash).toBe(await hashSsn(PEPPER_ESCROW_CANARY, 'the-pepper'))
      expect(atob(body.ciphertext).length).toBe(512)
      expect(vi.mocked(writeAuditLog).mock.calls[0][4]).toBe('ssn_pepper_escrow_sealed')
    })

    it('works once, then refuses and says when it was used', async () => {
      const e = env()
      expect((await post(app, '/admin/escrow-pepper', {}, e)).status).toBe(200)
      const second = await post(app, '/admin/escrow-pepper', {}, e)
      expect(second.status).toBe(409)
      expect(((await second.json()) as { sealed_at: string }).sealed_at).toMatch(/^\d{4}-\d\d-\d\dT/)
    })

    it('refuses when the pepper is not set rather than escrowing nothing', async () => {
      const res = await post(app, '/admin/escrow-pepper', {}, env({ SSN_HASH_PEPPER: '' }))
      expect(res.status).toBe(503)
    })
  })
})
