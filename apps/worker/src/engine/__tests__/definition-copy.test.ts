/**
 * The last-good copy of a live workflow definition (#1845, plan A2 on #1675).
 *
 * The loader keeps a 300 s cache and, before this, threw on a failed database
 * read, so a few minutes into an outage every live lead failed. It now keeps a
 * copy with no expiry, written on every successful live load and read ONLY when
 * the database read fails. Every test here drives the real supabase-js client
 * through a fetch that answers the way PostgREST does, so an outage is the
 * library's own error object rather than a hand made one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  loadWorkflowDefinition,
  refreshWorkflowCaches,
  WorkflowNotFoundError,
  workflowCopyKey,
  type WorkflowDefinitionCopy,
} from '../definition-loader'
import { assertWorkflowServedInLane, WorkflowLaneError } from '../lane'
import { createLeadSupabaseClient, LEAD_READ_DEADLINE_MS } from '../../lib/lead-read-budget'
import type { Env } from '../../index'

const WF_ID = 'wf-copy-1'
const CACHE_KEY = `workflow-def-${WF_ID}`
const COPY_KEY = workflowCopyKey(WF_ID)
const T0 = Date.parse('2026-10-07T12:00:00Z')

interface Row {
  id: string
  name: string
  organization_id: string
  slack_channel: string | null
  definition: unknown
  is_active: boolean
  lane: string
  updated_at: string
  deleted_at: string | null
  workflow_versions: { id: string; version_number: number }[]
}

const baseRow: Row = {
  id: WF_ID,
  name: 'Engine Bidding',
  organization_id: 'org-1',
  slack_channel: '#alerts',
  definition: { nodes: [{ id: 'n1', type: 'response' }], edges: [] },
  is_active: true,
  lane: 'money',
  updated_at: '2026-10-07T11:00:00.123456+00:00',
  deleted_at: null,
  workflow_versions: [{ id: 'ver-7', version_number: 7 }],
}

/** An in-memory KV that records every read and write by key. */
function fakeKv() {
  const store = new Map<string, string>()
  const gets: string[] = []
  const puts: string[] = []
  const deletes: string[] = []
  const kv = {
    store, gets, puts, deletes,
    get: vi.fn(async (key: string, type?: string) => {
      gets.push(key)
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (key: string, value: string) => { puts.push(key); store.set(key, value) }),
    delete: vi.fn(async (key: string) => { deletes.push(key); store.delete(key) }),
  }
  return kv
}
type FakeKv = ReturnType<typeof fakeKv>
const asKv = (kv: FakeKv) => kv as unknown as KVNamespace

type DbState = { mode: 'up' | 'down-503' | 'down-500'; row: Row | null; requests: number }

/**
 * A PostgREST stand-in behind the real supabase-js client. It applies the two
 * filters the live query sends, so an inactive or deleted row answers the way
 * the real server answers `.single()` with no rows: 406 and PGRST116.
 */
function realClient(db: DbState): SupabaseClient {
  return createClient('https://db.test', 'service-key', { auth: { persistSession: false }, global: { fetch: answerAs(db) } })
}

/** The fake PostgREST network both client kinds run over. */
function answerAs(db: DbState): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    db.requests += 1
    if (db.mode === 'down-503') {
      // PostgREST's own answer while it cannot reach Postgres. Retry-After: 0
      // keeps the library's retries (it retries a 503) from waiting real seconds.
      return new Response(
        JSON.stringify({ code: 'PGRST002', details: null, hint: null, message: 'Could not query the database for the schema cache. Retrying.' }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } },
      )
    }
    if (db.mode === 'down-500') {
      return new Response(
        JSON.stringify({ code: '57P01', details: null, hint: null, message: 'terminating connection due to administrator command' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const url = new URL(String(input))
    const row = db.row
    const onlyActive = url.searchParams.get('is_active') === 'eq.true'
    const onlyLive = url.searchParams.get('deleted_at') === 'is.null'
    if (!row || (onlyActive && !row.is_active) || (onlyLive && row.deleted_at !== null)) {
      return new Response(
        JSON.stringify({ code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' }),
        { status: 406, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify(row), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

/** A lead's client over the same network, recording the deadlines it is given (#1844). */
function leadClient(db: DbState, asked: number[]): SupabaseClient {
  return createLeadSupabaseClient({ SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'service-key' } as unknown as Env, {
    fetch: answerAs(db),
    deadline: (ms) => { asked.push(ms); return new AbortController().signal },
  })
}

function heldCopy(kv: FakeKv): WorkflowDefinitionCopy | null {
  const raw = kv.store.get(COPY_KEY)
  return raw === undefined ? null : (JSON.parse(raw) as WorkflowDefinitionCopy)
}

let logLines: string[]
beforeEach(() => {
  logLines = []
  const capture = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')) }
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
})
afterEach(() => { vi.restoreAllMocks() })

function eventsNamed(event: string): Record<string, unknown>[] {
  return logLines
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event === event)
}

/** Warms the copy the way production does: one successful live load. */
async function warm(kv: FakeKv, row: Row = baseRow, at = T0) {
  const db: DbState = { mode: 'up', row, requests: 0 }
  await loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db), { now: () => at })
}

describe('writing the copy', () => {
  it('a successful live load writes a copy carrying is_active, lane, the version and when it was written', async () => {
    const kv = fakeKv()
    await warm(kv)

    const copy = heldCopy(kv)
    expect(copy).not.toBeNull()
    expect(copy!.is_active).toBe(true)
    expect(copy!.lane).toBe('money')
    expect(copy!.workflow_version_id).toBe('ver-7')
    expect(copy!.version_number).toBe(7)
    expect(copy!.row_updated_at).toBe(baseRow.updated_at)
    expect(copy!.written_at).toBe(new Date(T0).toISOString())
    expect(copy!.workflow).toEqual({
      definition: baseRow.definition,
      workflow_version_id: 'ver-7',
      workflow_name: 'Engine Bidding',
      org_id: 'org-1',
      slack_channel: '#alerts',
      lane: 'money',
    })
    // The 300 s cache is still the hot path, written first and with its TTL.
    expect(kv.puts[0]).toBe(CACHE_KEY)
  })

  it('a test or shadow run (allowInactive) neither writes nor reads the copy', async () => {
    const kv = fakeKv()
    const db: DbState = { mode: 'up', row: { ...baseRow, is_active: false }, requests: 0 }
    await loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db), { allowInactive: true })
    expect(kv.gets).not.toContain(COPY_KEY)
    expect(kv.puts).not.toContain(COPY_KEY)
  })

  it('a failed copy write does not fail the lead, and says so in one structured line', async () => {
    const kv = fakeKv()
    kv.put.mockImplementation(async (key: string, value: string) => {
      if (key === COPY_KEY) throw new Error('KV PUT failed: 429 Too Many Requests')
      kv.store.set(key, value)
    })
    const db: DbState = { mode: 'up', row: baseRow, requests: 0 }
    const loaded = await loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db))
    expect(loaded.workflow_version_id).toBe('ver-7')
    const [line] = eventsNamed('workflow_definition_copy_write_failed')
    expect(line).toMatchObject({ workflow_id: WF_ID })
    expect(String(line.reason)).toContain('429')
  })
})

describe('never rolled back by a slower writer', () => {
  it('a load that read an OLDER row leaves a newer copy in place', async () => {
    const kv = fakeKv()
    const newer: Row = { ...baseRow, updated_at: '2026-10-07T11:05:00.000001+00:00', workflow_versions: [{ id: 'ver-8', version_number: 8 }] }
    await warm(kv, newer)
    expect(heldCopy(kv)!.workflow_version_id).toBe('ver-8')

    // A writer whose read began before the save lands afterwards.
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 1000)
    expect(heldCopy(kv)!.workflow_version_id).toBe('ver-8')
    expect(eventsNamed('workflow_definition_copy_write_skipped')).toHaveLength(1)
  })

  it('orders on the microseconds PostgREST returns, not the milliseconds Date.parse keeps', async () => {
    const kv = fakeKv()
    await warm(kv, { ...baseRow, updated_at: '2026-10-07T11:00:00.123457+00:00', definition: { nodes: [], edges: [], newer: true } })
    kv.store.delete(CACHE_KEY)
    await warm(kv, { ...baseRow, updated_at: '2026-10-07T11:00:00.123456+00:00' }, T0 + 1000)
    expect(heldCopy(kv)!.workflow!.definition).toEqual({ nodes: [], edges: [], newer: true })
  })

  it('a newer version on the same row stamp replaces the copy (a save inserts the version before it updates the row)', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.store.delete(CACHE_KEY)
    await warm(kv, { ...baseRow, workflow_versions: [{ id: 'ver-8', version_number: 8 }] }, T0 + 1000)
    expect(heldCopy(kv)!.workflow_version_id).toBe('ver-8')
  })

  it('the same version is rewritten once the held copy has aged, so its stamp stays fresh while the database is healthy', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 60_000)
    expect(heldCopy(kv)!.written_at).toBe(new Date(T0).toISOString())
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 6 * 60_000)
    expect(heldCopy(kv)!.written_at).toBe(new Date(T0 + 6 * 60_000).toISOString())
  })
})

describe('serving the copy when the database read fails', () => {
  it.each(['down-503', 'down-500'] as const)('serves the copy on a %s and logs one line naming the workflow and the copy age', async (mode) => {
    const kv = fakeKv()
    await warm(kv)
    kv.store.delete(CACHE_KEY) // the 300 s cache has expired: only the copy is left

    const db: DbState = { mode, row: baseRow, requests: 0 }
    const loaded = await loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db), { now: () => T0 + 90_000 })

    expect(db.requests).toBeGreaterThan(0) // the database was really asked first
    expect(loaded).toEqual(heldCopy(kv)!.workflow)
    const served = eventsNamed('workflow_definition_served_from_copy')
    expect(served).toHaveLength(1)
    expect(served[0]).toMatchObject({ workflow_id: WF_ID, workflow_version_id: 'ver-7', copy_age_ms: 90_000, copy_written_at: new Date(T0).toISOString() })
  })

  it('with no copy, the failure is thrown as a retryable error, never an empty definition', async () => {
    const kv = fakeKv()
    const db: DbState = { mode: 'down-503', row: baseRow, requests: 0 }
    const promise = loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db))
    await expect(promise).rejects.toThrow(/Failed to load workflow wf-copy-1/)
    await expect(promise).rejects.not.toBeInstanceOf(WorkflowNotFoundError)
  })

  it('a workflow the database says is genuinely not found is never served from the copy', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.store.delete(CACHE_KEY)
    kv.gets.length = 0
    const db: DbState = { mode: 'up', row: { ...baseRow, is_active: false }, requests: 0 }
    await expect(loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db))).rejects.toBeInstanceOf(WorkflowNotFoundError)
    expect(kv.gets).not.toContain(COPY_KEY)
  })

  it('a copy recording the workflow as switched off is refused as not found', async () => {
    const kv = fakeKv()
    await warm(kv)
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: { ...baseRow, is_active: false, updated_at: '2026-10-07T11:10:00+00:00' }, requests: 0 }))

    const db: DbState = { mode: 'down-503', row: baseRow, requests: 0 }
    await expect(loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db))).rejects.toBeInstanceOf(WorkflowNotFoundError)
    expect(eventsNamed('workflow_definition_copy_refused')[0]).toMatchObject({ workflow_id: WF_ID, reason: 'inactive' })
  })

  it('a copy stored under another lane is served as stored, so the engine refuses it exactly as it refuses that row when the database is up', async () => {
    const kv = fakeKv()
    await warm(kv, { ...baseRow, lane: 'ops' })
    kv.store.delete(CACHE_KEY)
    const loaded = await loadWorkflowDefinition(WF_ID, asKv(kv), realClient({ mode: 'down-503', row: baseRow, requests: 0 }))
    expect(loaded.lane).toBe('ops')
    expect(() => assertWorkflowServedInLane(WF_ID, loaded.lane, 'money')).toThrow(WorkflowLaneError)
  })

  it('a copy whose lane is not one the engine knows is not served', async () => {
    const kv = fakeKv()
    await warm(kv)
    const damaged = heldCopy(kv)!
    kv.store.set(COPY_KEY, JSON.stringify({ ...damaged, lane: 'sideways', workflow: { ...damaged.workflow, lane: 'sideways' } }))
    kv.store.delete(CACHE_KEY)
    await expect(
      loadWorkflowDefinition(WF_ID, asKv(kv), realClient({ mode: 'down-503', row: baseRow, requests: 0 })),
    ).rejects.toThrow(/Failed to load workflow/)
    expect(eventsNamed('workflow_definition_copy_refused')[0]).toMatchObject({ reason: 'unreadable' })
  })

  it('a test or shadow run (allowInactive) never falls back to the copy', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.gets.length = 0
    const db: DbState = { mode: 'down-503', row: baseRow, requests: 0 }
    await expect(
      loadWorkflowDefinition(WF_ID, asKv(kv), realClient(db), { allowInactive: true }),
    ).rejects.toThrow(/Failed to load workflow/)
    expect(kv.gets).not.toContain(COPY_KEY)
  })
})

describe('refreshWorkflowCaches: what a save, switch off, delete or restore leaves behind', () => {
  it('a save rewrites the copy with the new version and drops the 300 s cache', async () => {
    const kv = fakeKv()
    await warm(kv)
    const saved: Row = { ...baseRow, definition: { nodes: [], edges: [] }, updated_at: '2026-10-07T11:10:00+00:00', workflow_versions: [{ id: 'ver-8', version_number: 8 }] }
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: saved, requests: 0 }), { now: () => T0 + 5000 })
    expect(kv.store.has(CACHE_KEY)).toBe(false)
    expect(heldCopy(kv)).toMatchObject({ is_active: true, workflow_version_id: 'ver-8', written_at: new Date(T0 + 5000).toISOString() })
    expect(heldCopy(kv)!.workflow!.definition).toEqual({ nodes: [], edges: [] })
  })

  it.each([
    ['switched off', { is_active: false }],
    ['deleted', { is_active: false, deleted_at: '2026-10-07T11:10:00+00:00' }],
  ])('a workflow %s leaves a copy that refuses, and a slower writer holding the old row cannot bring it back', async (_what, change) => {
    const kv = fakeKv()
    await warm(kv)
    const after: Row = { ...baseRow, ...change, updated_at: '2026-10-07T11:10:00+00:00' }
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: after, requests: 0 }))
    expect(heldCopy(kv)).toMatchObject({ is_active: false, workflow: null })

    // A lead whose database read began before the switch off writes afterwards.
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 1000)
    expect(heldCopy(kv)!.is_active).toBe(false)
  })

  it('switching a workflow back on writes a live copy again', async () => {
    const kv = fakeKv()
    await warm(kv)
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: { ...baseRow, is_active: false, updated_at: '2026-10-07T11:10:00+00:00' }, requests: 0 }))
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: { ...baseRow, updated_at: '2026-10-07T11:20:00+00:00' }, requests: 0 }))
    expect(heldCopy(kv)).toMatchObject({ is_active: true, workflow_version_id: 'ver-7' })
  })

  it('a switch off whose read back fails leaves a copy that refuses, which a slower loader holding the pre-change row cannot bring back', async () => {
    const kv = fakeKv()
    await warm(kv)
    // The route switched the workflow off; reading the row back then failed.
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'down-500', row: { ...baseRow, is_active: false }, requests: 0 }))
    expect(kv.store.has(CACHE_KEY)).toBe(false)
    expect(heldCopy(kv)).toMatchObject({ is_active: false, unverified: true, workflow: null })
    expect(eventsNamed('workflow_definition_copy_refusing')[0]).toMatchObject({ workflow_id: WF_ID })

    // A lead whose database read began before the switch off writes afterwards.
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 1000)
    expect(heldCopy(kv)).toMatchObject({ is_active: false, unverified: true })

    // In an outage, once the 300 s cache has run out, that copy is no usable
    // copy: the run fails retryably, exactly as with none.
    kv.store.delete(CACHE_KEY)
    const promise = loadWorkflowDefinition(WF_ID, asKv(kv), realClient({ mode: 'down-503', row: baseRow, requests: 0 }))
    await expect(promise).rejects.toThrow(/Failed to load workflow wf-copy-1/)
    await expect(promise).rejects.not.toBeInstanceOf(WorkflowNotFoundError)
    expect(eventsNamed('workflow_definition_copy_refused').at(-1)).toMatchObject({ workflow_id: WF_ID, reason: 'unverified' })
  })

  it('the next successful load, which carries the new row stamp, replaces that refusing copy, even one microsecond newer', async () => {
    const kv = fakeKv()
    await warm(kv) // stamp ...00.123456
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'down-500', row: baseRow, requests: 0 }))
    kv.store.delete(CACHE_KEY)
    await warm(kv, { ...baseRow, updated_at: '2026-10-07T11:00:00.123457+00:00', workflow_versions: [{ id: 'ver-8', version_number: 8 }] }, T0 + 2000)
    expect(heldCopy(kv)).toMatchObject({ is_active: true, workflow_version_id: 'ver-8' })
    expect(heldCopy(kv)!.unverified).toBeUndefined()
  })

  it('with no copy held, a failed read back keeps none, which refuses the same way', async () => {
    const kv = fakeKv()
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'down-500', row: baseRow, requests: 0 }))
    expect(kv.store.has(COPY_KEY)).toBe(false)
    expect(eventsNamed('workflow_definition_copy_dropped')[0]).toMatchObject({ workflow_id: WF_ID })
  })

  it('when the row is gone altogether, the copy refuses as not found and a slower loader cannot bring it back', async () => {
    const kv = fakeKv()
    await warm(kv)
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: null, requests: 0 }))
    expect(heldCopy(kv)).toMatchObject({ is_active: false, workflow: null })
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 1000)
    kv.store.delete(CACHE_KEY) // the 300 s cache has run out
    await expect(
      loadWorkflowDefinition(WF_ID, asKv(kv), realClient({ mode: 'down-503', row: baseRow, requests: 0 })),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError)
  })

  it('a row the engine would refuse (no version) leaves a copy that refuses, stamped with the row it read', async () => {
    const kv = fakeKv()
    await warm(kv)
    const unrunnable: Row = { ...baseRow, updated_at: '2026-10-07T11:10:00+00:00', workflow_versions: [] }
    await refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: unrunnable, requests: 0 }))
    expect(heldCopy(kv)).toMatchObject({ is_active: false, unverified: true, row_updated_at: unrunnable.updated_at })
    kv.store.delete(CACHE_KEY)
    await warm(kv, baseRow, T0 + 1000)
    expect(heldCopy(kv)!.unverified).toBe(true)
  })
})

describe('refreshWorkflowCaches when a KV call fails', () => {
  it('a failed write of the refusing copy deletes the held copy and throws, so the route reports the failure', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.put.mockImplementation(async (key: string, value: string) => {
      if (key === COPY_KEY) throw new Error('KV PUT failed: 503')
      kv.store.set(key, value)
    })
    await expect(
      refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: { ...baseRow, is_active: false, updated_at: '2026-10-07T11:10:00+00:00' }, requests: 0 })),
    ).rejects.toThrow(/KV PUT failed/)
    // The live copy of the switched off workflow is not left behind.
    expect(kv.store.has(COPY_KEY)).toBe(false)
    expect(eventsNamed('workflow_definition_copy_write_failed').at(-1)).toMatchObject({ workflow_id: WF_ID })
  })

  it('a failed drop of the 300 s cache still brings the copy up to the row, then throws', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.delete.mockImplementation(async (key: string) => {
      if (key === CACHE_KEY) throw new Error('KV DELETE failed: 503')
      kv.store.delete(key)
    })
    await expect(
      refreshWorkflowCaches(WF_ID, asKv(kv), realClient({ mode: 'up', row: { ...baseRow, is_active: false, updated_at: '2026-10-07T11:10:00+00:00' }, requests: 0 })),
    ).rejects.toThrow(/KV DELETE failed/)
    expect(heldCopy(kv)).toMatchObject({ is_active: false })
  })
})

describe('the definition read on a lead client (#1844, #1845)', () => {
  it('is bounded, never retried, and reaches the copy after one request when the database is down', async () => {
    const kv = fakeKv()
    await warm(kv)
    kv.store.delete(CACHE_KEY)
    const db: DbState = { mode: 'down-500', row: baseRow, requests: 0 }
    const asked: number[] = []
    const loaded = await loadWorkflowDefinition(WF_ID, asKv(kv), leadClient(db, asked), { now: () => T0 + 60_000 })
    expect(loaded.workflow_version_id).toBe('ver-7')
    expect(db.requests).toBe(1)
    expect(asked).toEqual([LEAD_READ_DEADLINE_MS])
  })

  it('is not given a deadline on a test or shadow run, which has no copy to fall back on', async () => {
    const db: DbState = { mode: 'up', row: baseRow, requests: 0 }
    const asked: number[] = []
    await loadWorkflowDefinition(WF_ID, asKv(fakeKv()), leadClient(db, asked), { allowInactive: true, now: () => T0 })
    expect(asked).toEqual([])
  })

  it('still answers a genuinely missing workflow as not found, without counting the database as down', async () => {
    const db: DbState = { mode: 'up', row: null, requests: 0 }
    await expect(loadWorkflowDefinition(WF_ID, asKv(fakeKv()), leadClient(db, []), { now: () => T0 })).rejects.toBeInstanceOf(WorkflowNotFoundError)
  })
})
