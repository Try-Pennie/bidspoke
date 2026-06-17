/**
 * Env var routes — CRUD, secret masking on read, CF secret sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/cf-secrets')
vi.mock('../../../lib/secret-crypto', () => ({
  encryptSecret: vi.fn().mockResolvedValue('encrypted-test-value'),
  decryptSecret: vi.fn().mockResolvedValue('decrypted-test-value'),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { setCfSecret, deleteCfSecret, listCfSecretNames } from '../../../lib/cf-secrets'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  list?: Record<string, unknown>[]
  single?: Record<string, unknown> | null
  insertResult?: Record<string, unknown>
  insertError?: { message: string }
  updateResult?: Record<string, unknown>
  deleteError?: { message: string }
}

function makeSupabase(tables: Record<string, TableConfig | TableConfig[]> = {}) {
  const callCounts: Record<string, number> = {}

  return {
    from: (table: string) => {
      const cfgRaw = tables[table] ?? {}
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg: TableConfig = Array.isArray(cfgRaw) ? (cfgRaw[idx] ?? {}) : cfgRaw

      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined

          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
          }

          if (prop === 'single') {
            return () =>
              cfg.single !== undefined
                ? cfg.single
                  ? Promise.resolve({ data: cfg.single, error: null })
                  : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
                : Promise.resolve({ data: null, error: null })
          }

          // .maybeSingle() returns the row or null without a not-found error —
          // used by the key-collision check on rename.
          if (prop === 'maybeSingle') {
            return () => Promise.resolve({ data: cfg.single ?? null, error: null })
          }

          if (prop === 'insert') {
            return () => {
              const ic: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  if (p === 'single') return () =>
                    Promise.resolve(
                      cfg.insertError
                        ? { data: null, error: cfg.insertError }
                        : { data: cfg.insertResult ?? null, error: null }
                    )
                  if (p === 'then') return (resolve: (v: unknown) => unknown) =>
                    Promise.resolve({ data: null, error: cfg.insertError ?? null }).then(resolve)
                  return () => ic
                },
              })
              return ic
            }
          }

          if (prop === 'update') {
            return () => {
              const uc: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  if (p === 'single') return () =>
                    Promise.resolve({ data: cfg.updateResult ?? null, error: null })
                  return () => uc
                },
              })
              return uc
            }
          }

          if (prop === 'delete') {
            return () => {
              const dc: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  if (p === 'then') return (resolve: (v: unknown) => unknown) =>
                    Promise.resolve({ data: null, error: cfg.deleteError ?? null }).then(resolve)
                  return () => dc
                },
              })
              return dc
            }
          }

          return () => chain
        },
      })
      return chain
    },
  }
}

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

  it('returns 200 when deleting a non-secret variable', async () => {
    const existing = { id: 'v1', key: 'API_URL', is_secret: false }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, environment_variables: { single: existing } }) as never
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
