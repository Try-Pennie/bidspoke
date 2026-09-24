/**
 * POST /api/admin/tripoint-lead-status-check: the Tripoint Lead status check
 * now, rather than at the next 13:00 UTC cron (#1524).
 *
 * The question after the Salesforce fix ships (#1525) is whether new sales
 * reach the Lead, and a day is too long to wait. The route runs the SAME check
 * the cron runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/tripoint-lead-status-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tripoint-lead-status-check')>()
  return { ...actual, checkTripointLeadStatus: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { checkTripointLeadStatus } from '../../../lib/tripoint-lead-status-check'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: Awaited<ReturnType<typeof makeApp>>, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return app.request('/admin/tripoint-lead-status-check', { method: 'POST', headers }, testEnv, mockCtx)
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

describe('POST /admin/tripoint-lead-status-check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>)
    app = await makeApp()
  })

  it('answers 200 with the counts when the Leads agree', async () => {
    vi.mocked(checkTripointLeadStatus).mockResolvedValue({
      day: '2026-09-23', submissions_completed: 600, leads_completed: 595, backlog: 0, findings: [], alerted: false,
    })

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, day: '2026-09-23', submissions_completed: 600, leads_completed: 595, backlog: 0 })
    expect(checkTripointLeadStatus).toHaveBeenCalledTimes(1)
  })

  it('answers 500 with the findings when they disagree, so a status-only caller cannot read agreement', async () => {
    vi.mocked(checkTripointLeadStatus).mockResolvedValue({
      day: '2026-09-23', submissions_completed: 409, leads_completed: 2, backlog: 21331,
      findings: ['2 of 409 Tripoint sales created on 2026-09-23 have a Lead reading Completed'], alerted: true,
    })

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; findings: string[] }
    expect(body.ok).toBe(false)
    expect(body.findings).toHaveLength(1)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await post(app, {})
    expect(res.status).toBe(401)
    expect(checkTripointLeadStatus).not.toHaveBeenCalled()
  })
})
