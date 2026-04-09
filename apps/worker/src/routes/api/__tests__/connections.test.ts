/**
 * Connections routes — PRD Section 3.1
 * Covers: list returns connections without credentials, create upserts + stores CF secret,
 * delete removes connection + CF secret, sync-schema calls correct fetcher + updates cache,
 * sync-schema returns 500 when credentials not in env.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/cf-secrets')
vi.mock('../../../lib/schema-sync/salesforce')
vi.mock('../../../lib/schema-sync/supabase-schema')
vi.mock('../../../lib/schema-sync/snowflake')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { setCfSecret, deleteCfSecret } from '../../../lib/cf-secrets'
import { fetchSalesforceSchema } from '../../../lib/schema-sync/salesforce'
import { fetchSupabaseSchema } from '../../../lib/schema-sync/supabase-schema'
import { fetchSnowflakeSchema } from '../../../lib/schema-sync/snowflake'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
  upsertResult?: Record<string, unknown> | null
  upsertError?: { message: string }
  updateError?: { message: string }
  deleteError?: { message: string }
}

function makeSupabase(tables: Record<string, TableConfig> = {}) {
  return {
    from: (table: string) => {
      const cfg: TableConfig = tables[table] ?? {}
      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined

          if (prop === 'single') {
            return () => cfg.single !== undefined
              ? cfg.single
                ? Promise.resolve({ data: cfg.single, error: null })
                : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
              : Promise.resolve({ data: null, error: null })
          }

          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
          }

          if (prop === 'upsert') {
            return () => {
              const uc: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  if (p === 'single') return () =>
                    Promise.resolve(
                      cfg.upsertError
                        ? { data: null, error: cfg.upsertError }
                        : { data: cfg.upsertResult ?? null, error: null }
                    )
                  return () => uc
                },
              })
              return uc
            }
          }

          if (prop === 'update') {
            return () => {
              const uc: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  if (p === 'then') return (resolve: (v: unknown) => unknown) =>
                    Promise.resolve({ data: null, error: cfg.updateError ?? null }).then(resolve)
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

const existingConn = {
  id: 'conn-1',
  service_type: 'salesforce',
  auth_type: 'oauth',
  cf_secret_key: 'CONN_EXISTING',
  schema_cache: null,
  schema_synced_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  updated_by_email: 'dan@pennie.com',
}

const upsertedConn = {
  id: 'conn-1',
  service_type: 'salesforce',
  auth_type: 'oauth',
  schema_cache: null,
  schema_synced_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  updated_by_email: 'dan@pennie.com',
}

const baseEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  CLOUDFLARE_API_TOKEN: 'tok-abc',
} as unknown as Env

// env with credentials pre-loaded (simulates CF secret available at runtime)
const envWithCreds = {
  ...baseEnv,
  CONN_EXISTING: JSON.stringify({ access_token: 'sf-token', instance_url: 'https://sf.example.com' }),
} as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(
  app: { request: Function },
  method: string,
  path: string,
  opts: { body?: unknown; env?: Env } = {}
) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, opts.env ?? baseEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /connections', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns list of connections without credentials', async () => {
    // Simulate what Supabase returns after the select() — cf_secret_key is not in the column list
    const { cf_secret_key: _omit, ...connWithoutCreds } = existingConn
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { list: [connWithoutCreds] } }) as never
    )
    const res = await request(app, 'GET', '/connections')
    expect(res.status).toBe(200)
    const body = await res.json() as typeof connWithoutCreds[]
    expect(body).toHaveLength(1)
    expect(body[0].service_type).toBe('salesforce')
    expect(Object.keys(body[0])).not.toContain('cf_secret_key')
  })
})

describe('POST /connections', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 400 for invalid service_type', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'POST', '/connections', {
      body: { service_type: 'github', credentials: { token: 'x' } },
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when credentials are missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as never
    )
    const res = await request(app, 'POST', '/connections', { body: { service_type: 'salesforce' } })
    expect(res.status).toBe(400)
  })

  it('creates a new connection and calls setCfSecret', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // single: null means no existing connection
        service_connections: { single: null, upsertResult: upsertedConn },
      }) as never
    )
    const res = await request(app, 'POST', '/connections', {
      body: { service_type: 'salesforce', credentials: { access_token: 'tok', instance_url: 'https://sf.test' } },
    })
    expect(res.status).toBe(201)
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith(
      expect.stringMatching(/^CONN_/),
      expect.stringContaining('access_token'),
      'acct-123',
      'tok-abc'
    )
  })

  it('reuses existing cf_secret_key when updating an existing connection', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { single: existingConn, upsertResult: upsertedConn },
      }) as never
    )
    await request(app, 'POST', '/connections', {
      body: { service_type: 'salesforce', credentials: { access_token: 'new-tok', instance_url: 'https://sf.test' } },
    })
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith(
      'CONN_EXISTING',
      expect.any(String),
      expect.any(String),
      expect.any(String)
    )
  })
})

describe('DELETE /connections/:service_type', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when connection does not exist', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: null } }) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(404)
  })

  it('returns 200 and deletes the CF secret', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { single: existingConn },
      }) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(vi.mocked(deleteCfSecret)).toHaveBeenCalledWith('CONN_EXISTING', 'acct-123', 'tok-abc')
  })
})

describe('POST /connections/:service_type/sync-schema', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('returns 404 when no connection exists', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: null } }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema')
    expect(res.status).toBe(404)
  })

  it('returns 500 when CF secret is not in env', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }) as never
    )
    // baseEnv does not have CONN_EXISTING
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema')
    expect(res.status).toBe(500)
  })

  it('calls fetchSalesforceSchema and updates schema_cache', async () => {
    const mockSchema = { objects: [{ name: 'Lead', label: 'Lead', fields: [] }] }
    vi.mocked(fetchSalesforceSchema).mockResolvedValue(mockSchema)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; object_count: number }
    expect(body.ok).toBe(true)
    expect(body.object_count).toBe(1)
    expect(vi.mocked(fetchSalesforceSchema)).toHaveBeenCalledWith(
      JSON.stringify({ access_token: 'sf-token', instance_url: 'https://sf.example.com' })
    )
  })

  it('calls fetchSupabaseSchema for supabase connections', async () => {
    const supabaseConn = { ...existingConn, service_type: 'supabase', cf_secret_key: 'CONN_EXISTING' }
    const mockSchema = { objects: [{ name: 'leads', label: 'leads', fields: [] }] }
    vi.mocked(fetchSupabaseSchema).mockResolvedValue(mockSchema)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: supabaseConn } }) as never
    )
    const res = await request(app, 'POST', '/connections/supabase/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchSupabaseSchema)).toHaveBeenCalled()
    expect(vi.mocked(fetchSalesforceSchema)).not.toHaveBeenCalled()
  })

  it('calls fetchSnowflakeSchema for snowflake connections', async () => {
    const snowflakeConn = { ...existingConn, service_type: 'snowflake', cf_secret_key: 'CONN_EXISTING' }
    const mockSchema = { objects: [] }
    vi.mocked(fetchSnowflakeSchema).mockResolvedValue(mockSchema)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: snowflakeConn } }) as never
    )
    const res = await request(app, 'POST', '/connections/snowflake/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchSnowflakeSchema)).toHaveBeenCalled()
  })

  it('returns 502 when the schema fetcher throws', async () => {
    vi.mocked(fetchSalesforceSchema).mockRejectedValue(new Error('Salesforce SObject list failed (401)'))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/401/)
  })
})
