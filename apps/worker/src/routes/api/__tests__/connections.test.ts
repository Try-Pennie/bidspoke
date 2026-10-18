/**
 * Connections routes — PRD Section 3.1
 * Covers: list returns connections without credentials, create refuses as
 * connections_moving with no Cloudflare call (#2331), delete removes the row with
 * no Cloudflare call (#2331), sync-schema calls the correct fetcher and updates
 * the cache, sync-schema returns 500 when credentials are not in env, and
 * (#2335 PR 7) a failed lookup answers its named code and writes nothing.
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
import { SchemaLookupError } from '../../../lib/schema-sync/errors'

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

const envWithSupabaseCreds = {
  ...baseEnv,
  CONN_EXISTING: JSON.stringify({ url: 'https://proj.supabase.co', service_role_key: 'sb-key' }),
} as unknown as Env

const envWithSnowflakeCreds = {
  ...baseEnv,
  CONN_EXISTING: JSON.stringify({ account: 'xy1.us-east-1', username: 'user', password: 'pass', database: 'DB' }),
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

// #2331 phase 1a: no salesforce, supabase or snowflake connection exists, and
// each CONN_ secret this route put created and deployed a new version of the
// bidding Worker. So it refuses by name, before reading the body or the table.
describe('POST /connections refuses: connections are moving (#2331)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('answers 410 connections_moving, puts no Cloudflare secret and writes no row', async () => {
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: null, upsertResult: upsertedConn } })
    const from = vi.spyOn(sb, 'from')
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections', {
      body: { service_type: 'salesforce', credentials: { access_token: 'tok', instance_url: 'https://sf.test' } },
    })
    expect(res.status).toBe(410)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('connections_moving')
    expect(body.message).toEqual(expect.any(String))
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
    expect(from.mock.calls.filter(([t]) => t === 'service_connections')).toEqual([])
    expect(sb.calls.service_connections ?? []).toEqual([])
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('refuses the same way when the organization already has a connection of that type', async () => {
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn, upsertResult: upsertedConn } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections', {
      body: { service_type: 'salesforce', credentials: { access_token: 'new-tok', instance_url: 'https://sf.test' } },
    })
    expect(res.status).toBe(410)
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
    expect(sb.calls.service_connections ?? []).toEqual([])
  })

  it('refuses before reading the body, so a malformed or Slack body is refused the same way', async () => {
    const sb = makeSupabase({ users: { single: testUser } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    for (const body of [{ service_type: 'slack', credentials: { bot_token: 'x' } }, { service_type: 'salesforce' }]) {
      const res = await request(app, 'POST', '/connections', { body })
      expect(res.status).toBe(410)
      expect((await res.json() as { error: string }).error).toBe('connections_moving')
    }
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
    expect(sb.calls.service_connections ?? []).toEqual([])
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

  // #2331 phase 1a: a secret delete is a secret change on the bidding Worker,
  // like a put, so the row goes and any CONN_ secret is left for the Phase 9
  // sign off path that removes orphans.
  it('returns 200, deletes the row, and makes no Cloudflare secret call', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: 'conn-1' }], error: null }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }, { rpc }) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('delete_service_connection_by_id', expect.objectContaining({ p_connection_id: 'conn-1' }))
    expect(vi.mocked(deleteCfSecret)).not.toHaveBeenCalled()
    expect(vi.mocked(setCfSecret)).not.toHaveBeenCalled()
  })

  // #2331, F119: the table's trigger audits every change once, naming the user
  // through the delete function's actor, so the route writes none. #2332: it
  // deletes the row it read by id, never every row of the type, so once release
  // 2 allows a second row of a service that one survives.
  it('deletes the row it read by id with the caller as actor, never by service type, and writes no route audit row', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: 'conn-1' }], error: null }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }, { rpc }) as never
    )
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('delete_service_connection_by_id', { p_organization_id: testUser.organization_id, p_connection_id: 'conn-1', p_actor: testUser.id })
    expect(rpc).not.toHaveBeenCalledWith('delete_service_connection', expect.anything())
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
    // #2331 phase 1a: POST refuses, so the message must not send anyone to
    // re-save the connection (L111).
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/re-?save/i)
    expect(body.error).toMatch(/credentials/i)
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
    // The plain fetch and the auth the legacy login builds (#2335 PR 7).
    expect(vi.mocked(fetchSalesforceSchema)).toHaveBeenCalledWith({
      service: 'salesforce',
      fetch: expect.any(Function),
      auth: { Authorization: 'Bearer sf-token' },
      instanceUrl: 'https://sf.example.com',
    })
  })

  it('hands the lookups the plain fetch', async () => {
    const globalFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', globalFetch)
    vi.mocked(fetchSalesforceSchema).mockImplementation(async (source) => {
      await source.fetch('https://sf.example.com/services/data/v59.0/sobjects/', { headers: { ...source.auth } })
      return { objects: [] }
    })
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }] }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    expect(globalFetch).toHaveBeenCalledWith('https://sf.example.com/services/data/v59.0/sobjects/', { headers: { Authorization: 'Bearer sf-token' } })
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
    const res = await request(app, 'POST', '/connections/supabase/sync-schema', { env: envWithSupabaseCreds })
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchSupabaseSchema)).toHaveBeenCalledWith({
      service: 'supabase',
      fetch: expect.any(Function),
      auth: { apikey: 'sb-key', Authorization: 'Bearer sb-key' },
      url: 'https://proj.supabase.co',
    })
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
    const res = await request(app, 'POST', '/connections/snowflake/sync-schema', { env: envWithSnowflakeCreds })
    expect(res.status).toBe(200)
    expect(vi.mocked(fetchSnowflakeSchema)).toHaveBeenCalledWith({
      service: 'snowflake',
      fetch: expect.any(Function),
      auth: { Authorization: `Basic ${btoa('user:pass')}`, 'X-Snowflake-Authorization-Token-Type': 'BASIC' },
      account: 'xy1.us-east-1',
      database: 'DB',
    })
  })

  it('returns 502 with the named code when a lookup fails', async () => {
    vi.mocked(fetchSalesforceSchema).mockRejectedValue(
      new SchemaLookupError({ code: 'schema_auth_refused', service: 'salesforce', step: 'object_list', status: 401 }),
    )
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // Lookup, then the schema UPDATE, whose .select('id') reports the row.
        service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }],
      }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string; code: string }
    expect(body.error).toMatch(/401/)
    expect(body.code).toBe('schema_auth_refused')
  })

  // L10: a describe that failed used to come back as the object with no
  // fields, which this route cached over the last good schema.
  it('a failed describe answers its name and leaves the cached schema alone', async () => {
    vi.mocked(fetchSalesforceSchema).mockRejectedValue(
      new SchemaLookupError({ code: 'schema_service_error', service: 'salesforce', step: 'object_describe', subject: 'Lead', status: 503 }),
    )
    const sb = makeSupabase({ users: { single: testUser }, service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe('schema_service_error')
    expect(body.error).toContain('describe Lead')
    expect((sb.calls.service_connections ?? []).filter(([m]) => m === 'update')).toEqual([])
  })

  it('a stored login that is not readable is a 500 by name, and none of it is repeated', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }) as never
    )
    const env = { ...baseEnv, CONN_EXISTING: 'sf-secret-999' } as unknown as Env
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env })
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).toContain('schema_credentials_malformed')
    expect(raw).not.toContain('sf-secret-999')
    expect(vi.mocked(fetchSalesforceSchema)).not.toHaveBeenCalled()
  })

  it('a stored login naming a database the lookups refuse is ours, a 500, and nothing is sent', async () => {
    const snowflakeConn = { ...existingConn, service_type: 'snowflake', cf_secret_key: 'CONN_EXISTING' }
    const globalFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', globalFetch)
    const real = await vi.importActual<typeof import('../../../lib/schema-sync/snowflake')>('../../../lib/schema-sync/snowflake')
    vi.mocked(fetchSnowflakeSchema).mockImplementationOnce(real.fetchSnowflakeSchema)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: [{ single: snowflakeConn }, { writeRows: [{ id: 'conn-1' }] }] }) as never
    )
    const env = {
      ...baseEnv,
      CONN_EXISTING: JSON.stringify({ account: 'xy1', username: 'u', password: 'p', database: 'DB; DROP TABLE X' }),
    } as unknown as Env
    const res = await request(app, 'POST', '/connections/snowflake/sync-schema', { env })
    expect(res.status).toBe(500)
    expect((await res.json() as { code: string }).code).toBe('schema_source_invalid')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('an unexpected error is not repeated to the browser (F120)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchSalesforceSchema).mockRejectedValue(new Error('boom with sf-token inside'))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }] }) as never
    )
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).toContain('schema_sync_failed')
    expect(raw).not.toContain('sf-token')
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
        { rpcs: { delete_service_connection_by_id: [] } },
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

// #2332, F124. DELETE and sync-schema act on a row found by service type alone,
// so each reads only a LEGACY row (sealed_for null, cf_secret_key set). An ops
// connection (sealed_for ops_key, cf_secret_key null) is removed only by Phase
// 8's delete, which refuses a referenced connection, writes the tombstone and
// revokes. With two rows of a type, `.single()` answers PGRST116, which these
// routes read as not found: a 404, never a 500. The store refuses the same way
// (delete_service_connection_by_id spares ops_key rows), proven against
// Postgres in supabase/tests/service_connections_delete_by_id.test.sql case D.
describe('legacy routes never reach an ops connection (#2332, F124)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const opsRow = { id: 'conn-ops', service_type: 'salesforce', cf_secret_key: null, sealed_for: 'ops_key' }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  const legacyFilters = (sb: ReturnType<typeof makeSupabase>) =>
    (sb.calls.service_connections ?? []).filter(([m]) => m === 'is' || m === 'not').map(([m, args]) => [m, ...args])

  it('DELETE reads only a legacy row of the type', async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: 'conn-1' }], error: null }))
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: existingConn } }, { rpc })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(200)
    expect(legacyFilters(sb)).toEqual([['is', 'sealed_for', null], ['not', 'cf_secret_key', 'is', null]])
  })

  it('DELETE with exactly one ops_key row of the type (none legacy) answers 404 and calls no delete', async () => {
    // The read is scoped to legacy rows, so with only an ops row it finds none.
    const rpc = vi.fn(async () => ({ data: [{ id: 'conn-ops' }], error: null }))
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: null } }, { rpc })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'DELETE', '/connections/salesforce')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sync-schema reads only a legacy row of the type', async () => {
    vi.mocked(fetchSalesforceSchema).mockResolvedValue({ objects: [] })
    const sb = makeSupabase({ users: { single: testUser }, service_connections: [{ single: existingConn }, { writeRows: [{ id: 'conn-1' }] }] })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(200)
    expect(legacyFilters(sb)).toEqual([['is', 'sealed_for', null], ['not', 'cf_secret_key', 'is', null]])
  })

  it('sync-schema answers 404, not the missing credentials message, for a row with no cf_secret_key', async () => {
    // Defence beside the filter: a row with no Cloudflare secret name is not a
    // legacy connection, so it is not found here.
    const sb = makeSupabase({ users: { single: testUser }, service_connections: { single: opsRow } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as never)
    const res = await request(app, 'POST', '/connections/salesforce/sync-schema', { env: envWithCreds })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Connection not found' })
    expect(vi.mocked(fetchSalesforceSchema)).not.toHaveBeenCalled()
  })
})
