/**
 * The database snapshot taken during a write stall (#2292).
 *
 * Writes stalled for minutes three times on 2026-10-16 and nothing recorded
 * what the database was doing while they did. A snapshot is now taken the
 * moment a post-response write times out, at most once per window, and kept in
 * KV. These tests drive the capture against a KV double, a claim double, and a
 * database read whose answer each test sets; the deadline is an injected sleep,
 * so nothing waits in real time (L524).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  captureStallSnapshot,
  countStallSnapshots,
  readStallSnapshots,
  stallSnapshotKey,
  StallSnapshotGate,
  STALL_SNAPSHOT_PREFIX,
  STALL_SNAPSHOT_TTL_SECONDS,
  STALL_SNAPSHOT_WINDOW_SECONDS,
  STALL_SNAPSHOT_DEADLINE_MS,
  STALL_SNAPSHOT_MAX_BYTES,
  STALL_SNAPSHOT_CLAIM_KEY,
  type CaptureDeps,
  type StallSnapshotRecord,
} from '../db-stall-snapshot'
import type { AlertClaims } from '../alert-claim'

const T0 = Date.parse('2026-10-16T18:30:58.000Z')
const TRIGGER = { label: 'lead_sightings.finalize', execution_id: 'ex-1', workflow_name: 'Main Flow' }

interface Stored { value: string; opts?: { expirationTtl?: number; metadata?: unknown } }

function makeKv(opts: { putThrows?: boolean } = {}) {
  const store = new Map<string, Stored>()
  return {
    store,
    put: vi.fn(async (k: string, value: string, o?: Stored['opts']) => {
      if (opts.putThrows) throw new Error('KV put failed')
      store.set(k, { value, opts: o })
    }),
    get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
    list: vi.fn(async (o: { prefix: string; limit?: number; cursor?: string }) => {
      const names = [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort()
      const start = o.cursor ? Number(o.cursor) : 0
      const limit = o.limit ?? 1000
      const page = names.slice(start, start + limit)
      const done = start + limit >= names.length
      return {
        keys: page.map((name) => ({ name, metadata: store.get(name)?.opts?.metadata })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + limit) }),
      }
    }),
  }
}

/** One answer per key per TTL, on the test's clock, as the Durable Object is. */
function makeClaims(now: () => number = () => T0): AlertClaims & { asked: string[] } {
  const heldUntil = new Map<string, number>()
  const asked: string[] = []
  return {
    asked,
    async claim(key, ttlSeconds) {
      asked.push(key)
      if ((heldUntil.get(key) ?? Number.NEGATIVE_INFINITY) > now()) return false
      heldUntil.set(key, now() + ttlSeconds * 1000)
      return true
    },
    async release(key) {
      heldUntil.delete(key)
    },
  }
}

const SNAPSHOT = {
  taken_at: '2026-10-16T18:30:58.100Z',
  max_connections: 120,
  total_backends: 63,
  backends_total: 2,
  backends_shown: 2,
  backends: [
    { pid: 101, usename: 'authenticator', application_name: 'postgrest', state: 'active', wait_event_type: 'Lock', wait_event: 'relation', query: 'UPDATE lead_sightings SET outcome_state = $1' },
    { pid: 102, usename: 'postgres', application_name: 'supabase/dashboard', state: 'active', wait_event_type: 'IO', wait_event: 'DataFileRead', query: 'select count(*) from execution_steps' },
  ],
  blocking: [{ pid: 101, blocked_by: [102], locktype: 'relation', mode: 'RowExclusiveLock', relation: 'public.lead_sightings' }],
  by_state: [{ state: 'active', count: 40 }, { state: 'idle', count: 23 }],
  by_client: [{ usename: 'authenticator', application_name: 'postgrest', state: 'active', count: 40 }],
}

/** A sleep that never ends unless the test lets the deadline fire. */
const never = () => new Promise<void>(() => {})

function deps(kv: ReturnType<typeof makeKv>, extra: Partial<CaptureDeps> = {}): CaptureDeps {
  let n = 0
  return {
    kv,
    claims: makeClaims(),
    read: async () => ({ data: SNAPSHOT, error: null }),
    now: () => T0,
    sleep: never,
    gate: new StallSnapshotGate(),
    id: () => `snap-${++n}`,
    ...extra,
  }
}

function only(kv: ReturnType<typeof makeKv>): { key: string; record: StallSnapshotRecord; opts?: Stored['opts'] } {
  const keys = [...kv.store.keys()]
  expect(keys).toHaveLength(1)
  const s = kv.store.get(keys[0])!
  return { key: keys[0], record: JSON.parse(s.value) as StallSnapshotRecord, opts: s.opts }
}

describe('captureStallSnapshot (#2292)', () => {
  it('stores what the database answered, with its trigger, under a time sorted key that expires in a few days', async () => {
    const kv = makeKv()
    const outcome = await captureStallSnapshot(deps(kv), TRIGGER)

    expect(outcome).toMatchObject({ kind: 'recorded', status: 'taken' })
    const { key, record, opts } = only(kv)
    expect(key).toBe(stallSnapshotKey(T0, 'snap-1'))
    expect(key.startsWith(STALL_SNAPSHOT_PREFIX)).toBe(true)
    expect(record.status).toBe('taken')
    expect(record.started_at).toBe(new Date(T0).toISOString())
    expect(record.trigger).toEqual(TRIGGER)
    expect(record.deadline_ms).toBe(STALL_SNAPSHOT_DEADLINE_MS)
    expect(record.snapshot).toEqual(SNAPSHOT)
    expect(opts?.expirationTtl).toBe(STALL_SNAPSHOT_TTL_SECONDS)
    expect(STALL_SNAPSHOT_TTL_SECONDS).toBeLessThanOrEqual(7 * 24 * 60 * 60)
    // The list carries the outcome, so counting snapshots never reads a body.
    expect(opts?.metadata).toEqual({ status: 'taken', started_at: new Date(T0).toISOString() })
  })

  it('records "timed out" when the database does not answer inside its own deadline, and aborts the request', async () => {
    const kv = makeKv()
    let signal: AbortSignal | undefined
    let fire!: () => void
    const deadline = new Promise<void>((r) => { fire = r })
    const sleep = vi.fn(() => deadline)
    const running = captureStallSnapshot(
      deps(kv, {
        read: (s) => {
          signal = s
          return new Promise(() => {})
        },
        sleep,
      }),
      TRIGGER,
    )
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(STALL_SNAPSHOT_DEADLINE_MS, expect.any(AbortSignal)))
    fire()
    const outcome = await running

    expect(outcome).toMatchObject({ kind: 'recorded', status: 'timed_out' })
    const { record, opts } = only(kv)
    expect(record.status).toBe('timed_out')
    expect(record.snapshot).toBeUndefined()
    expect(record.error).toMatch(/did not answer within 3000 ms/)
    expect(opts?.metadata).toMatchObject({ status: 'timed_out' })
    expect(signal?.aborted).toBe(true)
  })

  it('records "failed" with the error when the database refuses the call', async () => {
    const kv = makeKv()
    const outcome = await captureStallSnapshot(
      deps(kv, { read: async () => ({ data: null, error: { code: '42501', message: 'permission denied for function db_stall_snapshot' } }) }),
      TRIGGER,
    )

    expect(outcome).toMatchObject({ kind: 'recorded', status: 'failed' })
    const { record } = only(kv)
    expect(record.status).toBe('failed')
    expect(record.error).toContain('42501')
    expect(record.error).toContain('permission denied')
  })

  it('records "failed" when the read throws rather than answering', async () => {
    const kv = makeKv()
    const outcome = await captureStallSnapshot(deps(kv, { read: async () => { throw new Error('Network connection lost.') } }), TRIGGER)
    expect(outcome).toMatchObject({ kind: 'recorded', status: 'failed' })
    expect(only(kv).record.error).toContain('Network connection lost.')
  })

  it('takes one snapshot per window however many writes time out, so a 10 minute stall takes a handful', async () => {
    const kv = makeKv()
    let now = T0
    const claims = makeClaims(() => now)
    const gate = new StallSnapshotGate()
    const d = deps(kv, { claims, gate, now: () => now })
    // 10 minutes of stall, 20 timed out writes a second.
    for (let ms = 0; ms < 10 * 60 * 1000; ms += 50) {
      now = T0 + ms
      await captureStallSnapshot(d, TRIGGER)
    }
    const taken = [...kv.store.keys()].length
    expect(taken).toBeGreaterThanOrEqual(1)
    expect(taken).toBeLessThanOrEqual(Math.ceil((10 * 60) / STALL_SNAPSHOT_WINDOW_SECONDS))
    // The isolate's own gate spares the claim object a call per timed out write.
    expect(claims.asked.length).toBe(taken)
  })

  it('does not take a second snapshot when another isolate already claimed the window', async () => {
    const kv = makeKv()
    const claims = makeClaims()
    await claims.claim(STALL_SNAPSHOT_CLAIM_KEY, STALL_SNAPSHOT_WINDOW_SECONDS)
    const read = vi.fn(async () => ({ data: SNAPSHOT, error: null }))
    const outcome = await captureStallSnapshot(deps(kv, { claims, read }), TRIGGER)
    expect(outcome).toEqual({ kind: 'skipped', reason: 'claim' })
    expect(read).not.toHaveBeenCalled()
    expect(kv.store.size).toBe(0)
  })

  it('still takes the snapshot when the claim object throws, since a missing snapshot is worse than a duplicate', async () => {
    const kv = makeKv()
    const claims: AlertClaims = { claim: async () => { throw new Error('object down') }, release: async () => {} }
    const outcome = await captureStallSnapshot(deps(kv, { claims }), TRIGGER)
    expect(outcome).toMatchObject({ kind: 'recorded', status: 'taken' })
  })

  it('never throws, and says so in the log, when the snapshot cannot be stored', async () => {
    const kv = makeKv({ putThrows: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await captureStallSnapshot(deps(kv), TRIGGER)
    expect(outcome).toMatchObject({ kind: 'unrecorded', status: 'taken' })
    expect(err.mock.calls.flat().join(' ')).toMatch(/could not store/)
    err.mockRestore()
  })

  it('cuts every query text to 300 characters before storing it', async () => {
    const kv = makeKv()
    const long = { ...SNAPSHOT, backends: [{ ...SNAPSHOT.backends[0], query: 'x'.repeat(5000) }] }
    await captureStallSnapshot(deps(kv, { read: async () => ({ data: long, error: null }) }), TRIGGER)
    const stored = only(kv).record.snapshot as typeof SNAPSHOT
    expect(stored.backends[0].query).toHaveLength(300)
  })

  it('bounds the stored size: an oversized answer keeps its counts and chains and drops the backend list', async () => {
    const kv = makeKv()
    const backends = Array.from({ length: 2000 }, (_, i) => ({ ...SNAPSHOT.backends[0], pid: i, application_name: 'a'.repeat(200), query: 'q'.repeat(300) }))
    await captureStallSnapshot(deps(kv, { read: async () => ({ data: { ...SNAPSHOT, backends }, error: null }) }), TRIGGER)
    const { key } = only(kv)
    const raw = kv.store.get(key)!.value
    expect(raw.length).toBeLessThanOrEqual(STALL_SNAPSHOT_MAX_BYTES)
    const record = JSON.parse(raw) as StallSnapshotRecord
    expect(record.truncated).toBe(true)
    const s = record.snapshot as typeof SNAPSHOT
    expect(s.backends).toEqual([])
    expect(s.by_state).toEqual(SNAPSHOT.by_state)
    expect(s.blocking).toEqual(SNAPSHOT.blocking)
  })
})

async function seedSnapshot(kv: ReturnType<typeof makeKv>, atMs: number, status: 'taken' | 'timed_out' | 'failed', id: string, withMetadata = true) {
  const record: StallSnapshotRecord = {
    v: 1,
    id,
    started_at: new Date(atMs).toISOString(),
    status,
    elapsed_ms: 10,
    deadline_ms: STALL_SNAPSHOT_DEADLINE_MS,
    trigger: TRIGGER,
  }
  await kv.put(stallSnapshotKey(atMs, id), JSON.stringify(record), withMetadata ? { metadata: { status, started_at: record.started_at } } : {})
}

describe('countStallSnapshots (#2292)', () => {
  it('counts only the snapshots inside the window, by outcome', async () => {
    const kv = makeKv()
    await seedSnapshot(kv, T0 - 60 * 60 * 1000, 'taken', 'before')
    await seedSnapshot(kv, T0, 'taken', 'a')
    await seedSnapshot(kv, T0 + 2 * 60 * 1000, 'timed_out', 'b')
    await seedSnapshot(kv, T0 + 4 * 60 * 1000, 'failed', 'c')
    await seedSnapshot(kv, T0 + 2 * 60 * 60 * 1000, 'taken', 'after')

    const counted = await countStallSnapshots(kv, T0 - 1000, T0 + 5 * 60 * 1000)
    expect(counted).toEqual({ attempts: 3, taken: 1, timed_out: 1, failed: 1, first_at: new Date(T0).toISOString() })
  })

  it('reads a body only when the list carries no outcome', async () => {
    const kv = makeKv()
    await seedSnapshot(kv, T0, 'timed_out', 'a', false)
    const counted = await countStallSnapshots(kv, T0 - 1000, T0 + 1000)
    expect(counted.timed_out).toBe(1)
    expect(kv.get).toHaveBeenCalledTimes(1)
  })

  it('answers zero attempts when none was taken', async () => {
    const counted = await countStallSnapshots(makeKv(), T0, T0 + 1000)
    expect(counted).toEqual({ attempts: 0, taken: 0, timed_out: 0, failed: 0, first_at: null })
  })

  it('narrows the KV list to the window rather than listing every snapshot kept', async () => {
    const kv = makeKv()
    await countStallSnapshots(kv, T0, T0 + 10 * 60 * 1000)
    const prefix = kv.list.mock.calls[0][0].prefix
    expect(prefix.length).toBeGreaterThan(STALL_SNAPSHOT_PREFIX.length + 4)
    expect(stallSnapshotKey(T0, 'x').startsWith(prefix)).toBe(true)
    expect(stallSnapshotKey(T0 + 10 * 60 * 1000, 'x').startsWith(prefix)).toBe(true)
  })
})

describe('readStallSnapshots (#2292)', () => {
  it('lists every kept snapshot newest first and returns the newest bodies in full', async () => {
    const kv = makeKv()
    await seedSnapshot(kv, T0, 'taken', 'a')
    await seedSnapshot(kv, T0 + 1000, 'timed_out', 'b')
    await seedSnapshot(kv, T0 + 2000, 'taken', 'c')

    const read = await readStallSnapshots(kv, { limit: 2 })
    expect(read.entries.map((e) => e.status)).toEqual(['taken', 'timed_out', 'taken'])
    expect(read.entries[0].started_at).toBe(new Date(T0 + 2000).toISOString())
    expect(read.latest.map((r) => r.id)).toEqual(['c', 'b'])
  })

  it('follows the KV cursor past one page', async () => {
    const kv = makeKv()
    for (let i = 0; i < 1200; i++) await seedSnapshot(kv, T0 + i * 1000, 'taken', `s${i}`)
    const read = await readStallSnapshots(kv, { limit: 1 })
    expect(read.entries).toHaveLength(1200)
    expect(read.latest[0].id).toBe('s1199')
  })
})
