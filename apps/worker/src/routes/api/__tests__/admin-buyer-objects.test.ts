/**
 * The buyer objects health and drill routes (#1410).
 *
 * Health is a GET that only looks: peek on the ledger and read on the claim,
 * with throwaway names. The drill WRITES (it reserves, sells and settles under
 * the rehearsal kind against a throwaway buyer), so it is a POST and is named a
 * drill (L206). Both sit behind jwtAuth like every /api route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/buyer-objects-health')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { buyerObjectsHealth, runBuyerObjectsDrill } from '../../../lib/buyer-objects-health'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const HEALTH = { ok: true, probed_at: '2027-09-20T15:30:00.000Z', ledger: { ok: true, ms: 12 }, sale: { ok: true, ms: 9 } }
const DRILL = {
  ok: true,
  ran_at: '2027-09-20T15:30:00.000Z',
  partner_id: 'drill-2027-09-20T15:30:00.000Z',
  scenarios: [{ name: 'two leads race for one slot', ok: true }],
  latency: { 'lead sale claim': { calls: 4, p50_ms: 3, p99_ms: 7, max_ms: 7 } },
}

async function request(method: string, path: string) {
  const { default: api } = await import('../index')
  return api.fetch(new Request(`https://x${path}`, { method, headers: { Authorization: 'Bearer t' } }), testEnv, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
  )
  vi.mocked(buyerObjectsHealth).mockResolvedValue(HEALTH as never)
  vi.mocked(runBuyerObjectsDrill).mockResolvedValue(DRILL as never)
})

describe('GET /api/admin/buyer-objects/health', () => {
  it('answers the probe report and runs no drill', async () => {
    const res = await request('GET', '/admin/buyer-objects/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(HEALTH)
    expect(buyerObjectsHealth).toHaveBeenCalledTimes(1)
    expect(runBuyerObjectsDrill).not.toHaveBeenCalled()
  })

  it('a probe that fails answers 503 with the report, so a dashboard sees red rather than a shape', async () => {
    vi.mocked(buyerObjectsHealth).mockResolvedValue({ ...HEALTH, ok: false, sale: { ok: false, ms: 2000, error: 'lead sale read did not answer within 2000 ms' } } as never)
    const res = await request('GET', '/admin/buyer-objects/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, sale: { ok: false } })
  })

  it('rejects without a token', async () => {
    const { default: api } = await import('../index')
    const res = await api.fetch(new Request('https://x/admin/buyer-objects/health'), testEnv, mockCtx)
    expect(res.status).toBe(401)
    expect(buyerObjectsHealth).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/buyer-objects/drill', () => {
  it('runs the drill and answers its report', async () => {
    const res = await request('POST', '/admin/buyer-objects/drill')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DRILL)
    expect(runBuyerObjectsDrill).toHaveBeenCalledTimes(1)
  })

  it('a drill with a failed scenario answers 500 with the report', async () => {
    vi.mocked(runBuyerObjectsDrill).mockResolvedValue({ ...DRILL, ok: false, scenarios: [{ name: 'kill after reserve', ok: false, detail: 'expected outcome_unknown, got sold' }] } as never)
    const res = await request('POST', '/admin/buyer-objects/drill')
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false })
  })

  it('is not reachable by GET, so nobody can start it by looking (L206)', async () => {
    const res = await request('GET', '/admin/buyer-objects/drill')
    expect(res.status).toBe(404)
    expect(runBuyerObjectsDrill).not.toHaveBeenCalled()
  })
})
