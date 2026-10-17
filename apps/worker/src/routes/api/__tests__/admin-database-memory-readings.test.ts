/**
 * The database-memory readings route is a GET that only looks (#2010).
 *
 * It reads the worker's own KV ring buffer of `event=database_memory` figures so the 600/500
 * MB swap thresholds can be calibrated against real readings. It is a GET: it reads, it never
 * runs anything (L206). A storage outage is a 503 carrying the error, never an empty list that
 * reads as "nothing recorded yet" (L11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { DATABASE_MEMORY_READINGS_KEY, type StoredMemoryReading } from '../../../lib/database-memory-readings'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const mockCtx = recordingContext()

const reading = (at: number): StoredMemoryReading => ({ at, freePct: 60, availableMb: 2400, totalMb: 4010, swapUsedMb: 260, swapHigh: false })

function kv(opts: { value?: string; throws?: boolean } = {}) {
  return {
    get: async (k: string) => {
      if (opts.throws) throw new Error('KV read failed')
      return k === DATABASE_MEMORY_READINGS_KEY ? (opts.value ?? null) : null
    },
    put: async () => {},
  }
}

function envWith(kvImpl: ReturnType<typeof kv>): Env {
  return { SUPABASE_JWKS_URL: 'https://fake.jwks', IDEMPOTENCY: kvImpl } as unknown as Env
}

async function request(method: string, env: Env) {
  const { default: api } = await import('../index')
  return api.fetch(new Request('https://x/admin/database-memory-readings', { method, headers: { Authorization: 'Bearer t' } }), env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>)
})

describe('GET /api/admin/database-memory-readings', () => {
  it('answers the recorded readings, oldest first, with their window bounds', async () => {
    const readings = [reading(1000), reading(2000), reading(3000)]
    const res = await request('GET', envWith(kv({ value: JSON.stringify(readings) })))

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; count: number; oldestAt: number; newestAt: number; readings: StoredMemoryReading[] }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(3)
    expect(body.oldestAt).toBe(1000)
    expect(body.newestAt).toBe(3000)
    expect(body.readings.map((r) => r.swapUsedMb)).toEqual([260, 260, 260])
  })

  it('answers an empty list before anything has been recorded', async () => {
    const res = await request('GET', envWith(kv()))

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; count: number; oldestAt: number | null; readings: unknown[] }
    expect(body.count).toBe(0)
    expect(body.oldestAt).toBeNull()
    expect(body.readings).toEqual([])
  })

  it('answers 503 with the error when the store cannot be read, not a healthy empty list', async () => {
    const res = await request('GET', envWith(kv({ throws: true })))

    expect(res.status).toBe(503)
    const body = await res.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('KV read failed')
  })

  it('answers 503 when the stored buffer is corrupt, not a healthy empty list (L10)', async () => {
    const res = await request('GET', envWith(kv({ value: 'not a json array' })))

    expect(res.status).toBe(503)
    const body = await res.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('corrupt')
  })

  it('answers 200 but reports dropped>0 when only some stored entries are an unrecognised shape', async () => {
    const res = await request('GET', envWith(kv({ value: JSON.stringify([reading(1000), { old: 'shape' }]) })))
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; count: number; dropped: number }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
    expect(body.dropped).toBe(1)
  })

  it('is not reachable as a POST, so it cannot be confused with a route that runs something', async () => {
    const res = await request('POST', envWith(kv()))
    expect(res.status).toBe(404)
  })
})
