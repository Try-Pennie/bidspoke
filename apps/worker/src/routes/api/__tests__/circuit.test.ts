/**
 * Circuit breaker routes (#103): status/reset must verify the partner belongs
 * to the caller's org, and the reset audit row uses the partner's real id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'

type TableConfig = { single?: Record<string, unknown> | null; maybeSingle?: Record<string, unknown> | null }

function makeSupabase(tables: Record<string, TableConfig> = {}) {
  return {
    from: (table: string) => {
      const cfg = tables[table] ?? {}
      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'single') {
            return () => cfg.single
              ? Promise.resolve({ data: cfg.single, error: null })
              : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
          }
          if (prop === 'maybeSingle') {
            return () => Promise.resolve({ data: cfg.maybeSingle ?? null, error: null })
          }
          return () => chain
        },
      })
      return chain
    },
  }
}

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

// Durable Object stub: returns a status JSON; records reset calls.
const doFetch = vi.fn(async (url: string) =>
  url.includes('reset')
    ? new Response(null, { status: 200 })
    : new Response(JSON.stringify({ state: 'open', error_count_in_window: 5, error_threshold: 5, window_seconds: 60, cooldown_seconds: 300, opened_at: 1, consecutive_cooldowns: 0 }))
)
const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  CIRCUIT_BREAKER: { idFromName: () => 'do-id', get: () => ({ fetch: doFetch }) },
} as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(app: { request: Function }, method: string, path: string) {
  return app.request(path, { method, headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)
}

describe('circuit routes (#103)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns status for a partner in the caller org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { maybeSingle: { id: 'p-1', slug: 'tripoint' } } }) as never
    )
    const res = await request(app, 'GET', '/circuit/tripoint/status')
    expect(res.status).toBe(200)
  })

  it('404s status for a slug not in the caller org (no cross-org read)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { maybeSingle: null } }) as never
    )
    const res = await request(app, 'GET', '/circuit/someone-elses/status')
    expect(res.status).toBe(404)
  })

  it('resets and audits with the partner id for an owned partner', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { maybeSingle: { id: 'p-1', slug: 'tripoint' } } }) as never
    )
    const res = await request(app, 'POST', '/circuit/tripoint/reset')
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'circuit_breaker', 'p-1', 'circuit_force_closed', 'user-1', { name: 'tripoint' }
    )
  })

  it('404s reset for a slug not in the caller org and does not reset the breaker', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_configs: { maybeSingle: null } }) as never
    )
    const res = await request(app, 'POST', '/circuit/someone-elses/reset')
    expect(res.status).toBe(404)
    expect(doFetch).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
