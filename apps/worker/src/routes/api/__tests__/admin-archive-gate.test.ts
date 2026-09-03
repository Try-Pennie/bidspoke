/**
 * POST /api/admin/archive-gate: measuring the archived days now, rather than
 * waiting for tomorrow's 13:00 UTC cron (#986, #872).
 *
 * The reason it exists is the same reason `/admin/archive-settings-check` does.
 * The gate's payload probe reported all 16 days it had ever measured as missing
 * their bundles, while the independent row and step counts matched Postgres
 * exactly, and the cause was in the Snowflake client rather than the archive.
 * Confirming a change to that client could otherwise only be done by waiting a
 * day, which is exactly how a second wrong reading would survive just as long.
 *
 * The route runs the SAME gate the cron runs. A separate probe would be evidence
 * about the probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/archive-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/archive-gate')>()
  return { ...actual, runArchiveGate: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { runArchiveGate } from '../../../lib/archive-gate'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function day(archiveDay: string, over: Record<string, unknown> = {}) {
  return {
    archiveDay,
    measurement: { probeOk: true, probeSampled: 60 },
    refusals: [],
    daysLeft: 15,
    error: null,
    ...over,
  }
}

function summary(results: ReturnType<typeof day>[], over: Record<string, unknown> = {}) {
  const measured = results.filter((r) => r.error === null)
  return {
    daysConsidered: results.length,
    daysMeasured: measured.length,
    daysDeletable: measured.filter((r) => r.refusals.length === 0).length,
    results,
    failed: results.some((r) => r.error !== null),
    detail: 'measured some days',
    ...over,
  }
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: { request: Function }) {
  return app.request(
    '/admin/archive-gate',
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

type GateSummary = Awaited<ReturnType<typeof runArchiveGate>>

describe('POST /admin/archive-gate', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>,
    )
    vi.mocked(runArchiveGate).mockResolvedValue(
      summary([day('2026-08-28'), day('2026-08-29')]) as unknown as GateSummary,
    )
    app = await makeApp()
  })

  it('answers with what each day measured, so the verdict can be read rather than inferred', async () => {
    const res = await post(app)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      daysConsidered: number
      daysVerified: number
      days: { archiveDay: string; verified: boolean; probeOk: boolean | null }[]
    }
    expect(body.ok).toBe(true)
    expect(body.daysConsidered).toBe(2)
    expect(body.daysVerified).toBe(2)
    expect(body.days.map((d) => d.archiveDay)).toEqual(['2026-08-28', '2026-08-29'])
    expect(body.days.every((d) => d.verified && d.probeOk === true)).toBe(true)
  })

  it('runs the scheduled gate itself, not a copy of it', async () => {
    await post(app)

    expect(runArchiveGate).toHaveBeenCalledTimes(1)
  })

  it('does not answer 200 when a day refused', async () => {
    // A caller reading only the status code must not be able to mistake
    // "not verified" for "verified" (L98).
    vi.mocked(runArchiveGate).mockResolvedValue(
      summary([
        day('2026-08-28', {
          measurement: { probeOk: false, probeSampled: 60 },
          refusals: [{ code: 'probe-failed', message: 'no bundle at all for 01a0' }],
        }),
      ]) as unknown as GateSummary,
    )

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; days: { refusals: { code: string }[] }[] }
    expect(body.ok).toBe(false)
    expect(body.days[0]?.refusals.map((r) => r.code)).toEqual(['probe-failed'])
  })

  it('does not answer 200 when a day could not be measured at all', async () => {
    // Unmeasurable is not the same as refused, and neither is a pass.
    vi.mocked(runArchiveGate).mockResolvedValue(
      summary([day('2026-08-28', { measurement: null, error: 'Snowflake returned 3 of the 5 rows' })]) as unknown as GateSummary,
    )

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; days: { error: string | null }[] }
    expect(body.ok).toBe(false)
    expect(body.days[0]?.error).toContain('3 of the 5 rows')
  })

  it('refuses to call zero days a pass', async () => {
    // A watcher that reports success when it found nothing to watch is
    // indistinguishable from one that saw everything pass (L98). This is
    // reachable: the gate considers no days until the archiver has finished one.
    vi.mocked(runArchiveGate).mockResolvedValue(summary([]) as unknown as GateSummary)

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; daysConsidered: number }
    expect(body.ok).toBe(false)
    expect(body.daysConsidered).toBe(0)
  })

  it('refuses a caller with no token', async () => {
    const res = await app.request('/admin/archive-gate', { method: 'POST' }, testEnv, mockCtx)

    expect(res.status).toBe(401)
    expect(runArchiveGate).not.toHaveBeenCalled()
  })
})
