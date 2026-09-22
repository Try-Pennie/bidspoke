/**
 * POST /api/admin/tripoint-pricing-check: comparing Bidspoke's Tripoint price
 * with the Salesforce revenue formula now, rather than waiting for tomorrow's
 * 13:00 UTC cron (#1166).
 *
 * The first question after this check ships is whether the Worker's connected
 * app can read the Tooling API at all, and the answer must not take a day to
 * arrive. The route runs the SAME check the cron runs; a separate probe here
 * would be evidence about the probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/tripoint-pricing-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tripoint-pricing-check')>()
  return { ...actual, checkTripointPricing: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { checkTripointPricing } from '../../../lib/tripoint-pricing-check'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const rule = { floor: 10000, lowBand: { upTo: 12499, multiplier: 0.0009 }, highBand: { from: 12500, multiplier: 0.0012 } }
const note = { code: 'floor-not-modelled', message: 'Salesforce books no Tripoint revenue below $10,000 of debt' }

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: Awaited<ReturnType<typeof makeApp>>) {
  return app.request(
    '/admin/tripoint-pricing-check',
    { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    testEnv,
    mockCtx,
  )
}

function makeSupabase() {
  return {
    from: () => ({}) as Record<string, unknown>,
    rpc: (name: string) =>
      name === 'auth_user_with_allowlist'
        ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
        : Promise.resolve({ data: [], error: null }),
  }
}

describe('POST /admin/tripoint-pricing-check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>,
    )
    vi.mocked(checkTripointPricing).mockResolvedValue({ salesforce: rule, engine_tiers: null, differences: [], notes: [note], alerted: false })
    app = await makeApp()
  })

  it('answers with the rule it read and the comparison, so the verdict can be read rather than inferred', async () => {
    const res = await post(app)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; salesforce: typeof rule; differences: unknown[]; notes: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.salesforce).toEqual(rule)
    expect(body.differences).toEqual([])
    expect(body.notes).toEqual([note])
  })

  it('runs the scheduled check itself, not a copy of it', async () => {
    await post(app)
    expect(checkTripointPricing).toHaveBeenCalledTimes(1)
  })

  it('does not answer 200 when the two rules disagree', async () => {
    // A caller reading only the status code must not be able to mistake a
    // disagreement for agreement (L98).
    vi.mocked(checkTripointPricing).mockResolvedValue({
      salesforce: rule,
      engine_tiers: null,
      differences: [{ code: 'high-multiplier-disagrees', message: 'Bidspoke prices the high band at 0.0013 of debt, Salesforce books 0.0012' }],
      notes: [note],
      alerted: true,
    })

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; differences: { code: string }[] }
    expect(body.ok).toBe(false)
    expect(body.differences.map((d) => d.code)).toEqual(['high-multiplier-disagrees'])
  })

  it('does not answer 200 when the formula could not be read, because nothing was compared', async () => {
    vi.mocked(checkTripointPricing).mockResolvedValue({
      salesforce: null,
      engine_tiers: null,
      differences: [{ code: 'formula-unreadable', message: 'Tooling query failed (403): INSUFFICIENT_ACCESS' }],
      notes: [],
      alerted: true,
    })

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; salesforce: unknown }
    expect(body.ok).toBe(false)
    expect(body.salesforce).toBeNull()
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.request('/admin/tripoint-pricing-check', { method: 'POST' }, testEnv, mockCtx)
    expect(res.status).toBe(401)
    expect(checkTripointPricing).not.toHaveBeenCalled()
  })
})
