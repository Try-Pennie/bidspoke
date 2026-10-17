/**
 * GET /api/muted-alerts (#1047).
 *
 * Covers: auth is required; a muted export-alert condition is returned with its
 * return time; and a KV read failure becomes a 500 rather than an empty list
 * that would read as "nothing is muted" (L98).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const NOW_SECONDS = Math.floor(Date.parse('2026-10-13T12:00:00Z') / 1000)

/** A KV double keeping per-key expiry, returning it from list as Workers KV does. */
function idempotencyKv(opts: { failList?: boolean } = {}) {
  const store = new Map<string, { value: string; expiration?: number }>()
  return {
    store,
    async get(key: string) {
      return store.get(key)?.value ?? null
    },
    async put() {},
    async delete() {},
    async list(o: { prefix: string; cursor?: string }) {
      if (opts.failList) throw new Error('KV list failed: 500')
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(o.prefix))
        .map(([name, e]) => ({ name, expiration: e.expiration }))
      return { keys, list_complete: true as const, cursor: undefined, cacheStatus: null }
    },
  }
}

function makeEnv(kv: ReturnType<typeof idempotencyKv>): Env {
  return {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    IDEMPOTENCY: kv,
  } as unknown as Env
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

const mockCtx = recordingContext()

function request(app: { request: Function }, env: Env, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return app.request('/muted-alerts', { method: 'GET', headers }, env, mockCtx)
}

describe('GET /muted-alerts', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    app = await makeApp()
  })

  it('401s without an Authorization header', async () => {
    const res = await request(app, makeEnv(idempotencyKv()), {})
    expect(res.status).toBe(401)
  })

  it('returns the muted export-alert conditions with their return time', async () => {
    const kv = idempotencyKv()
    kv.store.set('export-alert:Archive ingest:cooldown', { value: '1', expiration: NOW_SECONDS + 3600 })
    kv.store.set('export-alert:Archive ingest:condition', { value: JSON.stringify({ since: '2026-10-13T06:00:00Z', alerts: 2 }), expiration: NOW_SECONDS + 1000 })

    const res = await request(app, makeEnv(kv))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { muted: Array<{ jobName: string; returnsAt: string | null; standingSince: string | null }> }
    expect(body.muted).toHaveLength(1)
    expect(body.muted[0].jobName).toBe('Archive ingest')
    expect(body.muted[0].returnsAt).not.toBeNull()
    expect(body.muted[0].standingSince).toBe('2026-10-13T06:00:00Z')
  })

  it('returns an empty list when nothing is muted', async () => {
    const res = await request(app, makeEnv(idempotencyKv()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { muted: unknown[] }
    expect(body.muted).toEqual([])
  })

  it('500s on a KV read failure rather than reporting an empty, healthy set (L98)', async () => {
    const res = await request(app, makeEnv(idempotencyKv({ failList: true })))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/could not read/i)
  })
})
