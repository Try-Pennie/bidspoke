/**
 * The archive health route is a GET that only looks (#959).
 *
 * The method is the contract. Every other archive route on this router runs
 * something, and this is the one somebody reaches for in a hurry when an alert
 * fires, so it must not be possible to start a job by trying it (L206).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/archive-health')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { archiveHealth } from '../../../lib/archive-health'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
const mockCtx = recordingContext()

const REPORT = {
  now: '2026-09-10T12:00:00.000Z',
  retentionDays: 7,
  jobs: { rows: [] },
  lock: { held: false, value: null },
  watermark: { hour: '2026-09-10T10:00:00.000Z', hoursBehind: 2 },
  backlog: { hoursOutstanding: 0, oldestDayOutstanding: null, nightsUntilOldestPurged: null, clearsBeforeOldestIsPurged: null },
  days: [],
  purgeLastRun: { rows: [] },
}

async function request(method: string, path: string) {
  const { default: api } = await import('../index')
  return api.fetch(
    new Request(`https://x${path}`, { method, headers: { Authorization: 'Bearer t' } }),
    testEnv,
    mockCtx,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>
  )
  vi.mocked(archiveHealth).mockResolvedValue(REPORT as never)
})

describe('GET /api/admin/archive-health', () => {
  it('answers the report', async () => {
    const res = await request('GET', '/admin/archive-health')

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.watermark).toEqual({ hour: '2026-09-10T10:00:00.000Z', hoursBehind: 2 })
  })

  it('answers 200 for a degraded archive, because that is a successful reading', async () => {
    // A 500 here would make "the archive is unwell" and "the health check is
    // itself broken" the same response to whoever is trying to tell them apart.
    vi.mocked(archiveHealth).mockResolvedValue({
      ...REPORT,
      watermark: { error: 'timeout' },
      backlog: { error: 'timeout' },
    } as never)

    const res = await request('GET', '/admin/archive-health')

    expect(res.status).toBe(200)
    const body = await res.json() as { watermark: { error?: string } }
    expect(body.watermark.error).toBe('timeout')
  })

  it('is not reachable as a POST, so it cannot be confused with the routes that run something', async () => {
    const res = await request('POST', '/admin/archive-health')

    expect(res.status).toBe(404)
    expect(vi.mocked(archiveHealth)).not.toHaveBeenCalled()
  })
})
