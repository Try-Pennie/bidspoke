/**
 * Env var routes — CRUD, secret masking on read, CF secret sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
// Only the writer is a double: changedFields is the pure diff the route builds
// its entry from, and mocking it away would make every entry read as key only.
vi.mock('../../../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/audit')>()),
  writeAuditLog: vi.fn(),
}))
vi.mock('../../../lib/cf-secrets')
vi.mock('../../../lib/secret-crypto', () => ({
  encryptSecret: vi.fn().mockResolvedValue('encrypted-test-value'),
  decryptSecret: vi.fn().mockResolvedValue('decrypted-test-value'),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { setCfSecret, deleteCfSecret, listCfSecretNames } from '../../../lib/cf-secrets'
import { makeSupabase } from './_supabase-mock'

// ── Supabase mock ─────────────────────────────────────────────────────────────

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn() },
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  CLOUDFLARE_API_TOKEN: 'tok-abc',
} as unknown as Env

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /env', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 200 with env var list', async () => {
    const vars = [
      { id: 'v1', key: 'API_URL', value: 'https://api.example.com', is_secret: false },
      { id: 'v2', key: 'SECRET_KEY', value: 's3cr3t', is_secret: true },
    ]
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { list: vars } }) as never
    )
    const res = await request(app, 'GET', '/env')
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ key: string; value: string | null; is_secret: boolean }>
    expect(Array.isArray(body)).toBe(true)
  })

  it('masks secret values (sets value to null)', async () => {
    const vars = [
      { id: 'v1', key: 'API_URL', value: 'https://api.example.com', is_secret: false },
      { id: 'v2', key: 'SECRET_KEY', value: 's3cr3t', is_secret: true },
    ]
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { list: vars } }) as never
    )
    const res = await request(app, 'GET', '/env')
    const body = await res.json() as Array<{ key: string; value: string | null; is_secret: boolean }>
    const apiUrl = body.find((v) => v.key === 'API_URL')
    const secretKey = body.find((v) => v.key === 'SECRET_KEY')
    expect(apiUrl?.value).toBe('https://api.example.com')
    expect(secretKey?.value).toBeNull()
  })
})

describe('POST /env', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 400 when key is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'POST', '/env', { body: { value: 'foo' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when is_secret=true but value is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'POST', '/env', { body: { key: 'MY_SECRET', is_secret: true } })
    expect(res.status).toBe(400)
  })

  it('returns 201 for a plain env var', async () => {
    const created = { id: 'v1', key: 'API_URL', value: 'https://api.example.com', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { insertResult: created } }) as never
    )
    const res = await request(app, 'POST', '/env', { body: { key: 'API_URL', value: 'https://api.example.com' } })
    expect(res.status).toBe(201)
    const body = await res.json() as { key: string; value: string }
    expect(body.key).toBe('API_URL')
    expect(body.value).toBe('https://api.example.com')
  })

  it('calls setCfSecret and masks value for secrets', async () => {
    const created = { id: 'v2', key: 'SECRET_KEY', value: null, is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { insertResult: created } }) as never
    )
    const res = await request(app, 'POST', '/env', { body: { key: 'SECRET_KEY', value: 's3cr3t', is_secret: true } })
    expect(res.status).toBe(201)
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith('SECRET_KEY', 's3cr3t', 'acct-123', 'tok-abc')
    const body = await res.json() as { value: null }
    expect(body.value).toBeNull()
  })
})

describe('PUT /env/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when variable not found', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: null } }) as never
    )
    const res = await request(app, 'PUT', '/env/nonexistent', { body: { value: 'new' } })
    expect(res.status).toBe(404)
  })

  it('returns 5xx (not a false 404) when the fetch lookup hits a real DB error (#320)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v1', { body: { value: 'new' } })
    expect(res.status).toBe(500)
  })

  it('returns 200 after updating a non-secret variable', async () => {
    const existing = { id: 'v1', key: 'API_URL', value: 'https://old.example.com', is_secret: false }
    const updated = { id: 'v1', key: 'API_URL', value: 'https://new.example.com', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { updateResult: updated }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v1', { body: { value: 'https://new.example.com' } })
    expect(res.status).toBe(200)
  })

  it('calls setCfSecret when updating a secret variable', async () => {
    const existing = { id: 'v2', key: 'SECRET_KEY', value: null, is_secret: true }
    const updated = { id: 'v2', key: 'SECRET_KEY', value: null, is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { updateResult: updated }],
      }) as never
    )
    await request(app, 'PUT', '/env/v2', { body: { value: 'new_secret_value' } })
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith('SECRET_KEY', 'new_secret_value', 'acct-123', 'tok-abc')
  })

  // #104: renaming a secret must move the Cloudflare secret to the new name and
  // remove the old one, even when no new value is supplied.
  // keyChanged PUTs do fetch → collision-check → update (3 env_var reads).
  it('renames a secret with no new value: copies CF secret to the new name and deletes the old', async () => {
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    const existing = { id: 'v3', key: 'OLD_KEY', value: 'ciphertext', is_secret: true, scope: 'global', workflow_id: null }
    const updated = { id: 'v3', key: 'NEW_KEY', value: 'encrypted-test-value', is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { single: null }, { updateResult: updated }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v3', { body: { key: 'NEW_KEY' } })
    expect(res.status).toBe(200)
    // Wrote the decrypted current value under the NEW name…
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith('NEW_KEY', 'decrypted-test-value', 'acct-123', 'tok-abc')
    // …and removed the orphaned old name.
    expect(vi.mocked(deleteCfSecret)).toHaveBeenCalledWith('OLD_KEY', 'acct-123', 'tok-abc')
  })

  it('rotating and renaming a secret together puts the new value under the new name and deletes the old', async () => {
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    const existing = { id: 'v4', key: 'OLD_KEY', value: 'ciphertext', is_secret: true, scope: 'global', workflow_id: null }
    const updated = { id: 'v4', key: 'NEW_KEY', value: 'encrypted-test-value', is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { single: null }, { updateResult: updated }],
      }) as never
    )
    await request(app, 'PUT', '/env/v4', { body: { key: 'NEW_KEY', value: 'rotated' } })
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith('NEW_KEY', 'rotated', 'acct-123', 'tok-abc')
    expect(vi.mocked(deleteCfSecret)).toHaveBeenCalledWith('OLD_KEY', 'acct-123', 'tok-abc')
  })

  it('rejects a rename that collides with another variable, without touching Cloudflare (#104)', async () => {
    const existing = { id: 'v7', key: 'OLD_KEY', value: 'ciphertext', is_secret: true, scope: 'global', workflow_id: null }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // collision check finds another row under NEW_KEY
        environment_variables: [{ single: existing }, { single: { id: 'other' } }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v7', { body: { key: 'NEW_KEY' } })
    expect(res.status).toBe(409)
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteCfSecret)).not.toHaveBeenCalled()
  })

  it('rejects an empty key', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'PUT', '/env/v5', { body: { key: '   ' } })
    expect(res.status).toBe(400)
  })

  it('rejects renaming a secret whose stored value cannot be recovered, without a new value', async () => {
    const existing = { id: 'v6', key: 'OLD_KEY', value: null, is_secret: true, scope: 'global', workflow_id: null }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { single: null }] }) as never
    )
    const res = await request(app, 'PUT', '/env/v6', { body: { key: 'NEW_KEY' } })
    expect(res.status).toBe(400)
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
  })
})

describe('DELETE /env/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when variable not found', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: null } }) as never
    )
    const res = await request(app, 'DELETE', '/env/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns 5xx (not a false 404) when the fetch lookup hits a real DB error (#320)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as never
    )
    const res = await request(app, 'DELETE', '/env/v1')
    expect(res.status).toBe(500)
  })

  it('returns 200 when deleting a non-secret variable', async () => {
    const existing = { id: 'v1', key: 'API_URL', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { writeRows: [{ id: 'v1' }] }],
      }) as never
    )
    const res = await request(app, 'DELETE', '/env/v1')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('calls deleteCfSecret when deleting a secret variable', async () => {
    const existing = { id: 'v2', key: 'SECRET_KEY', is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: existing } }) as never
    )
    await request(app, 'DELETE', '/env/v2')
    expect(vi.mocked(deleteCfSecret)).toHaveBeenCalledWith('SECRET_KEY', 'acct-123', 'tok-abc')
  })

  it('does not call deleteCfSecret for non-secret variables', async () => {
    const existing = { id: 'v1', key: 'API_URL', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: existing } }) as never
    )
    await request(app, 'DELETE', '/env/v1')
    expect(vi.mocked(deleteCfSecret)).not.toHaveBeenCalled()
  })
})

describe('GET /env/:id/reveal — DB error => 5xx, not 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns 404 for a genuinely missing variable', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: null } }) as never
    )
    const res = await request(app, 'GET', '/env/nonexistent/reveal')
    expect(res.status).toBe(404)
  })

  it('returns 5xx (not a false 404) when the fetch lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as never
    )
    const res = await request(app, 'GET', '/env/v1/reveal')
    expect(res.status).toBe(500)
  })
})

describe('POST /env/resync-secrets (#199)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('re-pushes only the secrets Cloudflare is missing, skipping ones with no saved value', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(new Set(['PRESENT_KEY']))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: {
          list: [
            { id: 'v1', key: 'PRESENT_KEY', value: 'enc' },   // in CF — left alone
            { id: 'v2', key: 'MISSING_KEY', value: 'enc' },    // missing — re-pushed
            { id: 'v3', key: 'NOVALUE_KEY', value: null },     // missing but no saved value — skipped
          ],
        },
      }) as never
    )

    const res = await request(app, 'POST', '/env/resync-secrets')
    expect(res.status).toBe(200)
    const body = await res.json() as { missing: number; resynced: string[]; skipped: { key: string }[] }
    expect(body.missing).toBe(2)
    expect(body.resynced).toEqual(['MISSING_KEY'])
    expect(body.skipped.map((s) => s.key)).toEqual(['NOVALUE_KEY'])
    // Only the missing-with-value secret is pushed; the present one is not touched.
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith('MISSING_KEY', 'decrypted-test-value', 'acct-123', 'tok-abc')
  })

  it('returns 503 when Cloudflare secret sync is not configured', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(null)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'POST', '/env/resync-secrets')
    expect(res.status).toBe(503)
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
  })
})

describe('DELETE /env/:id: zero-row + write DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404, writes no audit log, and does not invalidate the env cache when the delete matches zero rows', async () => {
    // #588: the row was found on read but the DELETE removed nothing. Reporting a
    // success here would audit a delete that never happened and pointlessly drop
    // the env-cache key.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: { key: 'API_URL', is_secret: false } }, { writeRows: [] }],
      }) as never
    )
    const res = await request(app, 'DELETE', '/env/v1')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Variable not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    // invalidateEnvCache drops the per-org KV key via WORKFLOW_CACHE.delete; it
    // must not run for a delete that changed nothing.
    expect(vi.mocked(testEnv.WORKFLOW_CACHE.delete)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete write hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: { key: 'API_URL', is_secret: false } }, { deleteError: { code: '42P01', message: 'relation missing' } }],
      }) as never
    )
    const res = await request(app, 'DELETE', '/env/v1')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #595: PUT /:id ends its write in .update().select().single(); a zero-row match
// there is PGRST116, which must become a 404, not the old 500. A real DB error
// must still be a retryable 500.
describe('PUT /env/:id: zero-row 404 vs real DB error (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  const existing = { id: 'v1', key: 'API_URL', value: 'https://old.example.com', is_secret: false }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 (not 500), skips audit, and does not invalidate the env cache when the update matches zero rows', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { single: null }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v1', { body: { value: 'https://new.example.com' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Variable not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    // invalidateEnvCache drops the per-org KV key via WORKFLOW_CACHE.delete.
    expect(vi.mocked(testEnv.WORKFLOW_CACHE.delete)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v1', { body: { value: 'https://new.example.com' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated row on the happy path', async () => {
    const updated = { id: 'v1', key: 'API_URL', value: 'https://new.example.com', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        environment_variables: [{ single: existing }, { updateResult: updated }],
      }) as never
    )
    const res = await request(app, 'PUT', '/env/v1', { body: { value: 'https://new.example.com' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { value: string }
    expect(body.value).toBe('https://new.example.com')
  })
})

/**
 * #1085 (L529): every env var audit entry carries the old and new value of
 * what moved, so a setting's history can be read from audit_log alone. On
 * 2026-08-31 ACHIEVE_MIN_VANTAGE_SCORE's eight entries recorded only the key,
 * and its history had to be inferred from when sends happened. A secret's
 * value is never recorded, in plaintext or as ciphertext (L222).
 */
describe('env var audit entries carry old and new values (#1085)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const changesOf = () => vi.mocked(writeAuditLog).mock.calls.map((c) => ({ action: c[4], changes: c[6] as Record<string, unknown> | undefined }))

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('a plain variable created records its first value against null, with its scope', async () => {
    const created = { id: 'v1', key: 'ACHIEVE_MIN_VANTAGE_SCORE', value: '600', is_secret: false, scope: 'global', workflow_id: null }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: { insertResult: created } }) as never)
    await request(app, 'POST', '/env', { body: { key: 'ACHIEVE_MIN_VANTAGE_SCORE', value: '600' } })
    expect(changesOf()).toEqual([{ action: 'created', changes: { key: 'ACHIEVE_MIN_VANTAGE_SCORE', scope: 'global', workflow_id: null, value: { old: null, new: '600' } } }])
  })

  it('a secret created records that a value was set and never the value', async () => {
    const created = { id: 'v2', key: 'SECRET_KEY', value: 'encrypted-test-value', is_secret: true, scope: 'global', workflow_id: null }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: { insertResult: created } }) as never)
    await request(app, 'POST', '/env', { body: { key: 'SECRET_KEY', value: 's3cr3t', is_secret: true } })
    const [entry] = changesOf()
    expect(entry).toEqual({ action: 'secret_rotated', changes: { key: 'SECRET_KEY', scope: 'global', workflow_id: null, value_set: true } })
    expect(JSON.stringify(entry.changes)).not.toMatch(/s3cr3t|encrypted-test-value/)
  })

  it('a plain variable updated records the old and new value', async () => {
    const existing = { id: 'v1', key: 'ACHIEVE_MIN_VANTAGE_SCORE', value: '600000', is_secret: false, folder_id: null }
    const updated = { ...existing, value: '600' }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { updateResult: updated }] }) as never)
    await request(app, 'PUT', '/env/v1', { body: { value: '600' } })
    expect(changesOf()).toEqual([{ action: 'updated', changes: { key: 'ACHIEVE_MIN_VANTAGE_SCORE', value: { old: '600000', new: '600' } } }])
  })

  it('a plain variable renamed records the old name beside the new, and no value when the value stayed', async () => {
    const existing = { id: 'v1', key: 'API_URL', value: 'https://api.example.com', is_secret: false, scope: 'global', workflow_id: null, folder_id: null }
    const updated = { ...existing, key: 'API_BASE_URL' }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { single: null }, { updateResult: updated }] }) as never)
    await request(app, 'PUT', '/env/v1', { body: { key: 'API_BASE_URL' } })
    expect(changesOf()).toEqual([{ action: 'updated', changes: { key: 'API_BASE_URL', renamed_from: 'API_URL' } }])
  })

  it('a variable moved to a folder records the old and new folder', async () => {
    const existing = { id: 'v1', key: 'API_URL', value: 'x', is_secret: false, folder_id: null }
    const updated = { ...existing, folder_id: 'f1' }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { updateResult: updated }], env_var_folders: { single: { id: 'f1' } } }) as never)
    await request(app, 'PUT', '/env/v1', { body: { folder_id: 'f1' } })
    expect(changesOf()).toEqual([{ action: 'updated', changes: { key: 'API_URL', folder_id: { old: null, new: 'f1' } } }])
  })

  it('a secret rotated records that it was rotated and never the old or new value, plaintext or ciphertext', async () => {
    const existing = { id: 'v2', key: 'SECRET_KEY', value: 'old-ciphertext', is_secret: true, folder_id: null }
    const updated = { ...existing, value: 'encrypted-test-value' }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { updateResult: updated }] }) as never)
    await request(app, 'PUT', '/env/v2', { body: { value: 'new_secret_value' } })
    const [entry] = changesOf()
    expect(entry).toEqual({ action: 'secret_rotated', changes: { key: 'SECRET_KEY', value_rotated: true } })
    expect(JSON.stringify(entry.changes)).not.toMatch(/new_secret_value|old-ciphertext|encrypted-test-value/)
  })

  it('a secret renamed without a new value records the rename and that no rotation happened', async () => {
    const existing = { id: 'v3', key: 'OLD_KEY', value: 'ciphertext', is_secret: true, scope: 'global', workflow_id: null, folder_id: null }
    const updated = { ...existing, key: 'NEW_KEY', value: 'encrypted-test-value' }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { single: null }, { updateResult: updated }] }) as never)
    await request(app, 'PUT', '/env/v3', { body: { key: 'NEW_KEY' } })
    expect(changesOf()).toEqual([{ action: 'secret_rotated', changes: { key: 'NEW_KEY', renamed_from: 'OLD_KEY', value_rotated: false } }])
  })

  it('a plain variable deleted records its last value against null', async () => {
    const existing = { id: 'v1', key: 'API_URL', value: 'https://api.example.com', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { writeRows: [{ id: 'v1' }] }] }) as never)
    await request(app, 'DELETE', '/env/v1')
    expect(changesOf()).toEqual([{ action: 'deleted', changes: { key: 'API_URL', value: { old: 'https://api.example.com', new: null } } }])
  })

  it('a secret deleted records the key only', async () => {
    const existing = { id: 'v2', key: 'SECRET_KEY', value: 'ciphertext', is_secret: true }
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, environment_variables: [{ single: existing }, { writeRows: [{ id: 'v2' }] }] }) as never)
    await request(app, 'DELETE', '/env/v2')
    const [entry] = changesOf()
    expect(entry).toEqual({ action: 'deleted', changes: { key: 'SECRET_KEY' } })
    expect(JSON.stringify(entry.changes)).not.toContain('ciphertext')
  })
})
