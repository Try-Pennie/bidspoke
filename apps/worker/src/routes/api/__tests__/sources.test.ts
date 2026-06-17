/**
 * API Sources routes — PRD Section 1.2
 * Covers: list returns org sources, create generates API key + 409 on duplicate,
 * delete removes key from map + 404 when not found.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/cf-secrets')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidateWorkflowCache } from '../../../engine/definition-loader'
import { writeAuditLog } from '../../../lib/audit'
import { setCfSecret } from '../../../lib/cf-secrets'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
  insertError?: { message: string; code?: string }
  insertResult?: Record<string, unknown> | null
}

function makeSupabase(tables: Record<string, TableConfig> = {}) {
  return {
    from: (table: string) => {
      const cfg = tables[table] ?? {}
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
          if (prop === 'insert') {
            return () => {
              const ic: unknown = new Proxy({}, {
                get(__, p) {
                  if (typeof p === 'symbol') return undefined
                  // .insert(...).select('id').single() resolves to the inserted row.
                  if (p === 'single') return () =>
                    Promise.resolve({ data: cfg.insertResult ?? null, error: cfg.insertError ?? null })
                  if (p === 'then') return (resolve: (v: unknown) => unknown) =>
                    Promise.resolve({ data: cfg.insertResult ?? null, error: cfg.insertError ?? null }).then(resolve)
                  return () => ic
                },
              })
              return ic
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

// API_KEY_MAP with one existing source
const EXISTING_KEY_MAP = JSON.stringify({ 'abcd1234': 'website_form' })

const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  API_KEY_MAP: EXISTING_KEY_MAP,
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

describe('GET /sources', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 200 with sources list', async () => {
    const sources = [{ name: 'website_form', api_key: 'abcd1234', created_at: '2026-01-01' }]
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: { list: sources },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'GET', '/sources')
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })
})

describe('POST /sources', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 400 when name is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: {} })
    expect(res.status).toBe(400)
  })

  it('returns 409 when source name already exists', async () => {
    // Uniqueness is now enforced by UNIQUE(organization_id, name) — the insert
    // returns a 23505 unique-violation.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: { insertError: { code: '23505', message: 'duplicate key value' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: { name: 'website_form' } })
    expect(res.status).toBe(409)
  })

  it('returns 201 with name and a 32-char hex api_key', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { insertResult: { id: 'src-new' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: { name: 'crm_intake' } })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string; api_key: string }
    expect(body.name).toBe('crm_intake')
    expect(body.api_key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('normalizes the name (lowercase, spaces → underscores)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { insertResult: { id: 'src-new' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: { name: 'CRM Intake' } })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string; api_key: string }
    expect(body.name).toBe('crm_intake')
  })

  it('strips URL-breaking characters from the name (#100)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { insertResult: { id: 'src-new' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: { name: '100%le/ads?' } })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string }
    expect(body.name).toBe('100leads')
  })

  it('rejects a name that sanitizes to empty (#100)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { insertResult: { id: 'src-new' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/sources', { body: { name: '///' } })
    expect(res.status).toBe(400)
  })

  it('audits creation as api_source with the real source id, not a random uuid (#105)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { insertResult: { id: 'src-7' } } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'POST', '/sources', { body: { name: 'newsrc' } })
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'api_source', 'src-7', 'created', 'user-1', expect.anything()
    )
  })

  it('rebuilds the key map from the table (derived, not read-modify-write)', async () => {
    // The rebuilt map comes from api_sources (post-insert state), so the new
    // source appears via the table, not by mutating the c.env snapshot.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: { insertResult: { id: 'src-new' }, list: [{ name: 'new_source', api_key: 'newkey' }] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'POST', '/sources', { body: { name: 'new_source' } })
    expect(vi.mocked(setCfSecret)).toHaveBeenCalledWith(
      'API_KEY_MAP',
      expect.stringContaining('new_source'),
      'acct-123',
      'tok-abc'
    )
  })

  it('preserves a manually-seeded key not present in the table', async () => {
    // EXISTING_KEY_MAP has abcd1234 → website_form. If website_form is NOT in
    // the table, it's a "manual" key and must survive the rebuild.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: { insertResult: { id: 'src-new' }, list: [{ name: 'new_source', api_key: 'newkey' }] },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'POST', '/sources', { body: { name: 'new_source' } })
    const [, mapJson] = vi.mocked(setCfSecret).mock.calls[0]
    const parsed = JSON.parse(mapJson)
    expect(parsed['abcd1234']).toBe('website_form') // manual key preserved
    expect(parsed['newkey']).toBe('new_source')     // table-derived key present
  })
})

describe('DELETE /sources/:name', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(invalidateWorkflowCache).mockResolvedValue(undefined)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(setCfSecret).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 when source name is not in the key map', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/sources/nonexistent_source')
    expect(res.status).toBe(404)
  })

  it('returns 200 when source is deleted', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { list: [{ name: 'website_form', api_key: 'abcd1234' }] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/sources/website_form')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('rebuilds the map without the deleted key before calling setCfSecret', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { list: [{ name: 'website_form', api_key: 'abcd1234' }] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/sources/website_form')
    const [, updatedMap] = vi.mocked(setCfSecret).mock.calls[0]
    const parsed = JSON.parse(updatedMap)
    expect(Object.values(parsed)).not.toContain('website_form')
    expect(parsed['abcd1234']).toBeUndefined() // deleted key revoked
  })

  it('preserves a manually-seeded key when deleting a different source', async () => {
    // EXISTING_KEY_MAP: abcd1234→website_form. Delete a table source ('crm') whose
    // key isn't the manual one — the manual abcd1234 must survive.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, api_sources: { list: [{ name: 'crm', api_key: 'crmkey' }] } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    await request(app, 'DELETE', '/sources/crm')
    const [, updatedMap] = vi.mocked(setCfSecret).mock.calls[0]
    const parsed = JSON.parse(updatedMap)
    expect(parsed['abcd1234']).toBe('website_form') // manual key preserved
    expect(parsed['crmkey']).toBeUndefined()        // deleted source's key gone
  })
})
