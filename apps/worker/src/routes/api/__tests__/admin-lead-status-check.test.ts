/**
 * POST /api/admin/lead-status-check: the per-partner Lead status check now,
 * rather than at the next 13:00 UTC cron (#1524, #1525).
 *
 * The question after a Salesforce fix ships is whether new sales reach the
 * Lead, and a day is too long to wait. The route runs the SAME check the cron
 * runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/lead-status-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/lead-status-check')>()
  return { ...actual, checkLeadStatus: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { checkLeadStatus } from '../../../lib/lead-status-check'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const partners = [
  { partner: 'Tripoint', judged: true, submissions_completed: 1035, leads_completed: 1033, backlog: 0, backlog_returning: 0 },
  { partner: 'AmOne', judged: true, submissions_completed: 63, leads_completed: 62, backlog: 0, backlog_returning: 0 },
  { partner: 'Engine', judged: false, submissions_completed: 696, leads_completed: 1, backlog: 73000, backlog_returning: 0 },
]

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: Awaited<ReturnType<typeof makeApp>>, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return app.request('/admin/lead-status-check', { method: 'POST', headers }, testEnv, mockCtx)
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

describe('POST /admin/lead-status-check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>)
    app = await makeApp()
  })

  it('answers 200 with every partner, the unjudged one included, when nothing is found', async () => {
    vi.mocked(checkLeadStatus).mockResolvedValue({ day: '2026-09-24', partners, findings: [], alerted: false })

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, day: '2026-09-24', partners })
    expect(checkLeadStatus).toHaveBeenCalledTimes(1)
  })

  it('answers 500 with the findings, so a status-only caller cannot read agreement', async () => {
    vi.mocked(checkLeadStatus).mockResolvedValue({
      day: '2026-09-24',
      partners,
      findings: ['AmOne: 0 of 63 sales created on 2026-09-24 have a Lead reading Completed'],
      alerted: true,
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
    expect(checkLeadStatus).not.toHaveBeenCalled()
  })
})
