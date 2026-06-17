/**
 * Partner-UUID routes (#105): create and delete must write audit rows with
 * entity_type 'partner_uuid' and the real row id (previously not audited at all).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'

type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
  insertResult?: Record<string, unknown> | null
  insertError?: { message: string; code?: string }
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

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env

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

describe('partner-uuids audit (#105)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('audits create as partner_uuid with the new row id', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        partner_uuid_map: { insertResult: { id: 'pu-9', partner_slug: 'tripoint', uuid: 'u-1' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'POST', '/partner-uuids', { body: { partner_slug: 'tripoint', uuid: 'u-1' } })
    expect(res.status).toBe(201)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'partner_uuid', 'pu-9', 'created', 'user-1', expect.anything()
    )
  })

  it('audits delete as partner_uuid with the row id', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, partner_uuid_map: {} }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, 'DELETE', '/partner-uuids/pu-9')
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'partner_uuid', 'pu-9', 'deleted', 'user-1'
    )
  })
})
