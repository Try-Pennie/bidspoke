/**
 * Service-presets routes — #320 (the false-404 class, 5697088).
 * PUT /:id must return a retryable 5xx when its lookup hits a real DB error,
 * and a 404 only for a genuinely missing preset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'

type TableConfig = {
  single?: Record<string, unknown> | null
  singleError?: { code: string; message: string }
  list?: Record<string, unknown>[]
}

function makeSupabase(tables: Record<string, TableConfig | TableConfig[]> = {}) {
  const callCounts: Record<string, number> = {}
  return {
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)]
      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'single') {
            return () =>
              cfg.singleError
                ? Promise.resolve({ data: null, error: cfg.singleError })
                : cfg.single
                ? Promise.resolve({ data: cfg.single, error: null })
                : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
          }
          if (prop === 'maybeSingle') {
            // jwtAuth checks the access allowlist; default the auth user to allowlisted.
            if (table === 'user_allowlist') return () => Promise.resolve({ data: { email: 'dan@pennie.com' }, error: null })
            return () => Promise.resolve({ data: cfg.single ?? null, error: null })
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
          }
          return () => chain
        },
      })
      return chain
    },
  }
}

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body ? JSON.stringify(body) : undefined },
    testEnv,
    mockCtx
  )
}

describe('PUT /service-presets/:id — DB error => 5xx, not 404 (#320)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 for a genuinely missing preset', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_presets: { single: null } }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/service-presets/missing', { name: 'X' })
    expect(res.status).toBe(404)
  })

  it('returns 5xx (not a false 404) when the lookup hits a real DB error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_presets: { singleError: { code: '57014', message: 'canceling statement due to statement timeout' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'PUT', '/service-presets/sp-1', { name: 'X' })
    expect(res.status).toBe(500)
  })
})
