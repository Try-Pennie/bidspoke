/**
 * POST /api/admin/archive-settings-check: asking the archive what its settings
 * are, now, rather than waiting for tomorrow's cron (#1050).
 *
 * The reason it exists is the bug it shipped with. The scheduled check ran daily
 * and reported its own refusal every morning for six days: the statement it used
 * to read the Time Travel window was one the reader identity may not run. A
 * change to that read could only be confirmed by waiting a day, which is how a
 * second wrong statement would have survived just as long.
 *
 * The route runs the SAME check the cron runs, deliberately. A separate probe
 * would be evidence about the probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/archive-settings-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/archive-settings-check')>()
  return { ...actual, checkArchiveSettings: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { checkArchiveSettings } from '../../../lib/archive-settings-check'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const CLEAN = {
  observed: {
    retentionDays: 30,
    surroundingRetentionDays: [
      { level: 'EXECUTIONS schema', days: 30 },
      { level: 'BIDSPOKE_ARCHIVE database', days: 30 },
    ],
    columns: ['execution_id'],
    unreadable: [],
  },
  differences: [],
  alerted: false,
}

const DRIFTED = {
  observed: { ...CLEAN.observed, retentionDays: 1 },
  differences: [{ code: 'retention-changed', message: "the archive table's Time Travel window is 1 day" }],
  alerted: true,
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

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: { request: Function }, headers: Record<string, string> = {}) {
  return app.request(
    '/admin/archive-settings-check',
    { method: 'POST', headers: { Authorization: 'Bearer tok', ...headers } },
    testEnv,
    mockCtx,
  )
}

describe('POST /admin/archive-settings-check', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>,
    )
    vi.mocked(checkArchiveSettings).mockResolvedValue(
      CLEAN as unknown as Awaited<ReturnType<typeof checkArchiveSettings>>,
    )
    app = await makeApp()
  })

  it('answers with what it observed, so the numbers can be read rather than inferred', async () => {
    const res = await post(app)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { observed: { retentionDays: number }; differences: unknown[] }
    expect(body.observed.retentionDays).toBe(30)
    expect(body.differences).toEqual([])
  })

  it('runs the scheduled check itself, not a copy of it', async () => {
    await post(app)

    expect(checkArchiveSettings).toHaveBeenCalledTimes(1)
  })

  it('does not answer 200 when the check found a difference', async () => {
    // A caller reading only the status code must not be able to mistake
    // "drifted" for "verified" (L98).
    vi.mocked(checkArchiveSettings).mockResolvedValue(
      DRIFTED as unknown as Awaited<ReturnType<typeof checkArchiveSettings>>,
    )

    const res = await post(app)

    expect(res.status).toBe(500)
    const body = (await res.json()) as { differences: { code: string }[] }
    expect(body.differences.map((d) => d.code)).toEqual(['retention-changed'])
  })

  it('refuses a caller with no token', async () => {
    const res = await app.request('/admin/archive-settings-check', { method: 'POST' }, testEnv, mockCtx)

    expect(res.status).toBe(401)
    expect(checkArchiveSettings).not.toHaveBeenCalled()
  })
})
