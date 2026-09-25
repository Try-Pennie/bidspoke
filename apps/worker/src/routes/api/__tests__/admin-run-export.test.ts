/**
 * POST /api/admin/run-export-now: manual trigger for the nightly Snowflake exports.
 *
 * There are two export jobs (lead sightings, and Achieve evaluations) and this one
 * endpoint fires either or both, so the operator has a single lever instead of two
 * near-identical routes. Covers the target selection, and the failure path: one
 * export blowing up must not silently swallow itself or cancel the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/sightings-export')
vi.mock('../../../lib/achieve-export')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { runSightingsExport } from '../../../lib/sightings-export'
import { runAchieveExport } from '../../../lib/achieve-export'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const SIGHTINGS_SUMMARY = { sightings_exported: 12, bids_exported: 3, errors: [] }
const ACHIEVE_SUMMARY = { trades_backfilled: 2, evaluations_exported: 25, errors: [] }

// Minimal Supabase stub: this route only needs jwtAuth's user lookup to resolve.
function makeSupabase() {
  return {
    from: () => ({}),
    rpc: (name: string) =>
      name === 'auth_user_with_allowlist'
        ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
        : Promise.resolve({ data: [], error: null }),
  }
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function runExport(app: { request: Function }, body?: Record<string, unknown>) {
  return app.request(
    '/admin/run-export-now',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    testEnv,
    mockCtx
  )
}

describe('POST /admin/run-export-now', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(runSightingsExport).mockResolvedValue(
      SIGHTINGS_SUMMARY as unknown as Awaited<ReturnType<typeof runSightingsExport>>
    )
    vi.mocked(runAchieveExport).mockResolvedValue(
      ACHIEVE_SUMMARY as unknown as Awaited<ReturnType<typeof runAchieveExport>>
    )
    app = await makeApp()
  })

  it('runs BOTH exports by default and returns a summary for each', async () => {
    const res = await runExport(app)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.achieve).toMatchObject({ evaluations_exported: 25 })
    expect(body.sightings).toMatchObject({ sightings_exported: 12 })
    expect(runAchieveExport).toHaveBeenCalledTimes(1)
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
  })

  it('runs Achieve BEFORE sightings, so the small export is never starved by the big drain', async () => {
    const order: string[] = []
    vi.mocked(runAchieveExport).mockImplementation(async () => {
      order.push('achieve')
      return ACHIEVE_SUMMARY as unknown as Awaited<ReturnType<typeof runAchieveExport>>
    })
    vi.mocked(runSightingsExport).mockImplementation(async () => {
      order.push('sightings')
      return SIGHTINGS_SUMMARY as unknown as Awaited<ReturnType<typeof runSightingsExport>>
    })

    await runExport(app)

    expect(order).toEqual(['achieve', 'sightings'])
  })

  it('target=achieve runs only the Achieve export', async () => {
    const res = await runExport(app, { target: 'achieve' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.achieve).toMatchObject({ evaluations_exported: 25 })
    expect(body.sightings).toBeUndefined()
    expect(runAchieveExport).toHaveBeenCalledTimes(1)
    expect(runSightingsExport).not.toHaveBeenCalled()
  })

  it('target=sightings runs only the sightings export', async () => {
    const res = await runExport(app, { target: 'sightings' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.sightings).toMatchObject({ sightings_exported: 12 })
    expect(body.achieve).toBeUndefined()
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
    expect(runAchieveExport).not.toHaveBeenCalled()
  })

  it('rejects an unknown target with 400 and runs nothing', async () => {
    const res = await runExport(app, { target: 'everything' })

    expect(res.status).toBe(400)
    expect(runAchieveExport).not.toHaveBeenCalled()
    expect(runSightingsExport).not.toHaveBeenCalled()
  })

  // Failure path. A thrown export must NOT come back as a 200 with an empty summary
  // (that reads as "ran fine, nothing to export"), and it must not cancel the other
  // export, which is independent of it.
  it('surfaces a thrown export as a 500 with the error, and still runs the other one', async () => {
    vi.mocked(runAchieveExport).mockRejectedValue(new Error('Snowflake 503'))

    const res = await runExport(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { errors: string[]; sightings?: unknown; achieve?: unknown }
    expect(body.errors.join(' ')).toContain('Snowflake 503')
    expect(body.errors.join(' ')).toContain('achieve')
    // The sightings export is independent, so it still ran and still reported.
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
    expect(body.sightings).toMatchObject({ sightings_exported: 12 })
    expect(body.achieve).toBeUndefined()
  })
})
