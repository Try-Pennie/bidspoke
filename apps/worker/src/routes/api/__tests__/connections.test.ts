/**
 * Connections routes — PRD Section 3.1
 * Covers: list returns connections without credentials, create upserts + stores CF secret,
 * delete removes connection + CF secret, sync-schema calls correct fetcher + updates cache,
 * sync-schema returns 500 when credentials not in env.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
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
import { makeSupabase } from './_supabase-mock'

// ── Supabase mock ─────────────────────────────────────────────────────────────

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

const mockCtx = recordingContext()

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

  it('writes no route audit row: the upsert sets updated_by, which the table trigger names (#2331, F119)', async () => {
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: null, upsertResult: upsertedConn } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections', {
      body: { service_type: 'salesforce', credentials: { access_token: 'tok', instance_url: 'https://sf.test' } },
    })
    expect(res.status).toBe(201)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    const upsert = (sb.calls.service_connections ?? []).find(([m]) => m === 'upsert')
    expect((upsert?.[1][0] as Record<string, unknown>).updated_by).toBe(testUser.id)
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
      makeSupabase(
        { users: { single: testUser }, service_connections: { single: existingConn } },
        // The delete function reports the row it removed.
        { rpcs: { delete_service_connection: [{ id: 'conn-1' }] } },
      ) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(vi.mocked(deleteCfSecret)).toHaveBeenCalledWith('CONN_EXISTING', 'acct-123', 'tok-abc')
  })

  // #2331, F119: the table's trigger audits every change once, naming the user
  // through delete_service_connection's actor, so the route writes none.
  it('deletes through delete_service_connection with the caller as actor, and writes no route audit row', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: 'conn-1' }], error: null }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }, { rpc }) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('delete_service_connection', { p_organization_id: testUser.organization_id, p_service_type: 'salesforce', p_actor: testUser.id })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('refuses a service type it does not manage, so the Slack connection is removed only by its own route (#2060)', async () => {
    // DELETE /api/integrations/slack also removes the org from the saved Slack
    // copy alerts post from in an outage; a Slack delete through here would not.
    const sb = makeSupabase({ users: { single: testUser }, service_connections: [{ single: { id: 'sc-slack', cf_secret_key: '' } }, { writeRows: [{ id: 'sc-slack' }] }] })
    const from = vi.spyOn(sb, 'from')
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'DELETE', '/connections/slack')
    expect(res.status).toBe(400)
    expect(from.mock.calls.filter(([t]) => t === 'service_connections')).toEqual([])
    expect(vi.mocked(deleteCfSecret)).not.toHaveBeenCalled()
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

  it('refuses a service type it does not manage before touching the table, so it never writes a Slack row (#2060)', async () => {
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: { id: 'sc-slack', cf_secret_key: '', service_type: 'slack' } } })
    const from = vi.spyOn(sb, 'from')
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections/slack/sync-schema')
    expect(res.status).toBe(400)
    expect(from.mock.calls.filter(([t]) => t === 'service_connections')).toEqual([])
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
      makeSupabase({
        users: { single: testUser },
        // Lookup, then the schema UPDATE, whose .select('id') reports the row.
        service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }],
      }) as never
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

  // #2331, F119: the schema write names its user through updated_by, so the
  // table trigger's one audit row names them and is not labelled direct SQL.
  it('sets updated_by on the schema write and writes no route audit row', async () => {
    vi.mocked(fetchSalesforceSchema).mockResolvedValue({ objects: [{ name: 'Lead', label: 'Lead', fields: [] }] })
    const sb = makeSupabase({ users: { single: testUser }, service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    const update = (sb.calls.service_connections ?? []).find(([m]) => m === 'update')
    expect((update?.[1][0] as Record<string, unknown>).updated_by).toBe(testUser.id)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('calls fetchSupabaseSchema for supabase connections', async () => {
    const supabaseConn = { ...existingConn, service_type: 'supabase', cf_secret_key: 'CONN_EXISTING' }
    const mockSchema = { objects: [{ name: 'leads', label: 'leads', fields: [] }] }
    vi.mocked(fetchSupabaseSchema).mockResolvedValue(mockSchema)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: [{ single: supabaseConn }, { writeRows: [{ id: 'conn-1' }] }],
      }) as never
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
      makeSupabase({
        users: { single: testUser },
        service_connections: [{ single: snowflakeConn }, { writeRows: [{ id: 'conn-1' }] }],
      }) as never
    )
    const res = await request(app, 'POST', '/connections/snowflake/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchSnowflakeSchema)).toHaveBeenCalled()
  })

  it('returns 502 when the schema fetcher throws', async () => {
    vi.mocked(fetchSalesforceSchema).mockRejectedValue(new Error('Salesforce SObject list failed (401)'))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // Lookup, then the schema UPDATE, whose .select('id') reports the row.
        service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }],
      }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/401/)
  })
})

describe('DELETE /connections/:service_type: zero-row + DB error (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(deleteCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 and writes no audit log when the delete matches zero rows', async () => {
    // #588: the connection existed at the read but the DELETE removed nothing, so
    // it must surface as a 404 rather than a success that audits a phantom delete.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, service_connections: { single: existingConn } },
        { rpcs: { delete_service_connection: [] } },
      ) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Connection not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase(
        { users: { single: testUser }, service_connections: { single: existingConn } },
        { rpc: async () => ({ data: null, error: { code: '42P01', message: 'relation missing' } }) },
      ) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

describe('POST /connections/:service_type/sync-schema: zero-row update (#588)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 and writes no audit log when the schema update matches zero rows', async () => {
    // #588: the schema fetch succeeds but the UPDATE that stores it touches no
    // row (connection deleted mid-request), so we must not report a synced schema.
    vi.mocked(fetchSalesforceSchema).mockResolvedValue({ objects: [{ name: 'Lead', label: 'Lead', fields: [] }] })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: [{ single: existingConn }, { writeRows: [] }],
      }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Connection not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
