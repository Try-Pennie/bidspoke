/**
 * Integrations routes — Slack OAuth connect, list connections, delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  single?: Record<string, unknown> | null
  maybeSingle?: Record<string, unknown> | null
  upsertResult?: Record<string, unknown>
  upsertError?: { message: string }
  deleteError?: { message: string }
}

function makeSupabase(tables: Record<string, TableConfig> = {}) {
  return {
    from: (table: string) => {
      const cfg: TableConfig = tables[table] ?? {}

      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined

          if (prop === 'maybeSingle') {
            return () => Promise.resolve({
              data: cfg.maybeSingle ?? null,
              error: null,
            })
          }

          if (prop === 'single') {
            return () =>
              cfg.single !== undefined
                ? cfg.single
                  ? Promise.resolve({ data: cfg.single, error: null })
                  : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
                : Promise.resolve({ data: null, error: null })
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

// ── Fetch mock helpers ─────────────────────────────────────────────────────────

function jsonFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: { forEach: vi.fn() },
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
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

describe('POST /integrations/slack/resolve', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    app = await makeApp()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 400 when bot_token is missing', async () => {
    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: {} })
    expect(res.status).toBe(400)
  })

  it('returns 400 when Slack auth.test rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonFetchResponse({ ok: false, error: 'invalid_auth' })
    ))
    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: { bot_token: 'bad-token' } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/invalid_auth/)
  })

  it('returns 200 with workspace_name and channels on success', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonFetchResponse({ ok: true, team: 'Pennie HQ' }))
      .mockResolvedValueOnce(jsonFetchResponse({
        ok: true,
        channels: [
          { id: 'C2', name: 'general' },
          { id: 'C1', name: 'alerts' },
        ],
      }))
    vi.stubGlobal('fetch', mockFetch)

    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: { bot_token: 'xoxb-valid' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { workspace_name: string; channels: Array<{ id: string; name: string }> }
    expect(body.workspace_name).toBe('Pennie HQ')
    expect(body.channels).toHaveLength(2)
    // channels are sorted by name
    expect(body.channels[0].name).toBe('alerts')
    expect(body.channels[1].name).toBe('general')
  })
})

describe('POST /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 400 when bot_token is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    const res = await request(app, 'POST', '/integrations/slack', { body: { default_channel: '#alerts' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when default_channel is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    const res = await request(app, 'POST', '/integrations/slack', { body: { bot_token: 'xoxb-123' } })
    expect(res.status).toBe(400)
  })

  it('returns 200 and upserts the connection', async () => {
    const upserted = { id: 'sc-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { upsertResult: upserted },
      }) as never
    )
    const res = await request(app, 'POST', '/integrations/slack', {
      body: { bot_token: 'xoxb-123', default_channel: '#alerts', workspace_name: 'Pennie HQ' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

describe('GET /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns { connected: false } when no Slack connection exists', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { maybeSingle: null } }) as never
    )
    const res = await request(app, 'GET', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { connected: boolean }
    expect(body.connected).toBe(false)
  })

  it('returns connection details when connected', async () => {
    const connection = {
      config: { bot_token: 'xoxb-secret', default_channel: '#alerts', workspace_name: 'Pennie HQ' },
      updated_at: '2026-01-02T00:00:00Z',
      updated_by_email: 'dan@pennie.com',
    }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { maybeSingle: connection } }) as never
    )
    const res = await request(app, 'GET', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { connected: boolean; workspace_name: string; default_channel: string }
    expect(body.connected).toBe(true)
    expect(body.workspace_name).toBe('Pennie HQ')
    expect(body.default_channel).toBe('#alerts')
  })
})

describe('DELETE /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 200 and deletes the connection', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { maybeSingle: { id: 'sc-1' } },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('still returns 200 when no connection existed', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { maybeSingle: null },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
  })
})
