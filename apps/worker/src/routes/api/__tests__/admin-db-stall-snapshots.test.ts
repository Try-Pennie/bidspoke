/**
 * Reading back the database snapshots taken during write stalls (#2292).
 *
 * A GET that only looks (L206): it reads the snapshots from KV and never calls
 * the database. A storage outage is a 503 carrying the error, never an empty
 * list that reads as "no stall was snapshotted" (L11).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { stallSnapshotKey, type StallSnapshotRecord } from '../../../lib/db-stall-snapshot'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const mockCtx = recordingContext()

const T0 = Date.parse('2026-10-16T18:30:58.000Z')

function record(atMs: number, id: string, status: StallSnapshotRecord['status']): StallSnapshotRecord {
  return {
    v: 1,
    id,
    started_at: new Date(atMs).toISOString(),
    status,
    elapsed_ms: 12,
    deadline_ms: 3000,
    trigger: { label: 'lead_sightings.finalize', execution_id: 'ex-1', workflow_name: 'Main Flow' },
    ...(status === 'taken' ? { snapshot: { by_state: [{ state: 'active', count: 40 }] } } : { error: 'db_stall_snapshot did not answer within 3000 ms' }),
  }
}

function kv(opts: { throws?: boolean } = {}) {
  const store = new Map<string, { value: string; metadata: unknown }>()
  const put = (r: StallSnapshotRecord) =>
    store.set(stallSnapshotKey(Date.parse(r.started_at), r.id), { value: JSON.stringify(r), metadata: { status: r.status, started_at: r.started_at } })
  return {
    put,
    get: async (k: string) => {
      if (opts.throws) throw new Error('KV read failed')
      return store.get(k)?.value ?? null
    },
    list: async (o: { prefix: string }) => {
      if (opts.throws) throw new Error('KV list failed')
      const names = [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort()
      return { keys: names.map((name) => ({ name, metadata: store.get(name)!.metadata })), list_complete: true }
    },
  }
}

function envWith(kvImpl: ReturnType<typeof kv>): Env {
  return { SUPABASE_JWKS_URL: 'https://fake.jwks', IDEMPOTENCY: kvImpl } as unknown as Env
}

async function request(env: Env, query = '', method = 'GET') {
  const { default: api } = await import('../index')
  return api.fetch(new Request(`https://x/admin/db-stall-snapshots${query}`, { method, headers: { Authorization: 'Bearer t' } }), env, mockCtx)
}

// The API module is imported once, ahead of the tests, so its cold import is
// not charged to the first test's 5 second limit on a loaded machine.
beforeAll(async () => {
  await import('../index')
}, 30_000)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as unknown as ReturnType<typeof createSupabaseClient>)
})

describe('GET /api/admin/db-stall-snapshots (#2292)', () => {
  it('lists every kept snapshot newest first, with the newest in full', async () => {
    const store = kv()
    store.put(record(T0, 'a', 'taken'))
    store.put(record(T0 + 120_000, 'b', 'timed_out'))
    store.put(record(T0 + 240_000, 'c', 'taken'))
    const res = await request(envWith(store), '?limit=2')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; count: number; entries: Array<{ status: string }>; latest: StallSnapshotRecord[] }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(3)
    expect(body.entries.map((e) => e.status)).toEqual(['taken', 'timed_out', 'taken'])
    expect(body.latest.map((r) => r.id)).toEqual(['c', 'b'])
    expect(body.latest[1].error).toContain('did not answer')
  })

  // The snapshots are platform wide and any signed in user may read this route,
  // so a running query, which belongs to whoever ran it, is never served here.
  it('withholds every query text, keeping who, what they wait on and what blocks them', async () => {
    const store = kv()
    const r = record(T0, 'a', 'taken')
    r.snapshot = {
      by_state: [{ state: 'active', count: 40 }],
      backends: [{ pid: 7, usename: 'postgres', application_name: 'supabase/dashboard', wait_event_type: 'IO', query: "select * from lead_sightings where ssn = '123-45-6789'" }],
      blocking: [{ pid: 8, blocked_by: [7], relation: 'public.lead_sightings', query: 'select 1' }],
    }
    store.put(r)
    const res = await request(envWith(store))
    const text = await res.text()
    expect(text).not.toContain('123-45-6789')
    expect(text).not.toContain('"query"')
    const body = JSON.parse(text) as { query_text: string; latest: Array<{ snapshot: { backends: Array<Record<string, unknown>>; blocking: Array<Record<string, unknown>> } }> }
    expect(body.query_text).toBe('withheld')
    expect(body.latest[0].snapshot.backends[0]).toMatchObject({ pid: 7, usename: 'postgres', application_name: 'supabase/dashboard', wait_event_type: 'IO' })
    expect(body.latest[0].snapshot.blocking[0]).toMatchObject({ pid: 8, blocked_by: [7], relation: 'public.lead_sightings' })
  })

  // The run that set a snapshot off belongs to one organization too: only the
  // kind of write is served, never which run or workflow it was.
  it('serves only the kind of write that set a snapshot off, never its run or workflow', async () => {
    const store = kv()
    store.put(record(T0, 'a', 'taken'))
    const text = await (await request(envWith(store))).text()
    expect(text).not.toContain('ex-1')
    expect(text).not.toContain('Main Flow')
    const body = JSON.parse(text) as { latest: Array<{ trigger: Record<string, unknown> }> }
    expect(body.latest[0].trigger).toEqual({ label: 'lead_sightings.finalize' })
  })

  it('returns five in full by default and never more than twenty', async () => {
    const store = kv()
    for (let i = 0; i < 25; i++) store.put(record(T0 + i * 1000, `s${i}`, 'taken'))
    const plain = (await (await request(envWith(store))).json()) as { latest: unknown[] }
    expect(plain.latest).toHaveLength(5)
    const capped = (await (await request(envWith(store), '?limit=500')).json()) as { latest: unknown[] }
    expect(capped.latest).toHaveLength(20)
  })

  it('answers an empty list when no stall has been snapshotted', async () => {
    const res = await request(envWith(kv()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, count: 0, entries: [], latest: [] })
  })

  it('answers 503 with the error when KV cannot be read, not a healthy empty list', async () => {
    const res = await request(envWith(kv({ throws: true })))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('KV list failed')
  })

  it('refuses a caller with no valid session', async () => {
    vi.mocked(verifyJwt).mockRejectedValue(new Error('bad token'))
    const res = await request(envWith(kv()))
    expect(res.status).toBe(401)
  })
})
