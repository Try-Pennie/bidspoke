/**
 * The bid matrix's last-good copy (#1849).
 *
 * A Partner Bid on the matrix resolver read its config and its rows from the
 * database on every attempt, with no copy behind either, so in an outage every
 * matrix bid threw. Each successful read now keeps a copy of the config and its
 * rows in KV (one per config and side, stamped with when it was confirmed),
 * served only when a read FAILS, never when the config is genuinely gone, and
 * refused past the thirty minute maximum like every other stored copy.
 *
 * The real supabase-js client runs throughout; only the network beneath it is
 * replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import type { ExecutionContext } from '../../types'
import { createLeadSupabaseClient } from '../lead-read-budget'
import { bidMatrixLastGoodKey, lookupMatrixBid } from '../bid-matrix-lookup'
import { STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS, StoredCopyRefusedError } from '../stored-copy-age'

const T0 = Date.UTC(2026, 9, 7, 12)
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const CONFIG = {
  id: 'c-1', is_active: true, last_synced_at: '2026-10-07T11:00:00Z',
  dimensions: [{ name: 'debt', payload_field: 'debt_amount', column: 'row' }, { name: 'vantage', payload_field: 'vantage_score', column: 'range' }],
}
const ROWS = [
  { id: 'r1', is_sell_off: false, row_id: 'A', row_low: 0, row_high: 10000, range_low: 600, range_high: 650, bid_amount: 25 },
  { id: 'r2', is_sell_off: false, row_id: 'B', row_low: 10000, row_high: 20000, range_low: 600, range_high: 650, bid_amount: 50 },
]

function fakeKv() {
  const store = new Map<string, { value: string; metadata: unknown }>()
  const puts: string[] = []
  return {
    store,
    puts,
    get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
    getWithMetadata: vi.fn(async (k: string) => ({ value: store.get(k)?.value ?? null, metadata: store.get(k)?.metadata ?? null })),
    put: vi.fn(async (k: string, value: string, opts?: { metadata?: unknown }) => { puts.push(k); store.set(k, { value, metadata: opts?.metadata ?? null }) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}
type Kv = ReturnType<typeof fakeKv>

/** The database: config and rows while up; `down` refuses every request, `rowsDown` refuses only the rows read. */
function database(tables: { config: Record<string, unknown> | null; rows: unknown[] }) {
  const state = { down: false, rowsDown: false, calls: 0 }
  const fetch = (async (input: RequestInfo | URL) => {
    state.calls++
    const table = new URL(String(input)).pathname.split('/').pop()
    if (state.down || (state.rowsDown && table === 'bid_matrix_rows')) throw new TypeError('fetch failed')
    if (table === 'partner_bid_configs') {
      if (tables.config === null) {
        return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows', hint: null }), { status: 406, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(tables.config), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(tables.rows), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { state, fetch, tables }
}

const ctx = (payload: Record<string, unknown>) => ({ trigger: { payload, source: 's', workflow_id: 'wf', org_id: 'org', trace_id: 't' }, steps: {}, env: {} }) as unknown as ExecutionContext
const LEAD = ctx({ debt_amount: 15000, vantage_score: 625 })

const lookup = (db: ReturnType<typeof database>, kv: Kv, nowMs: number, payload = LEAD) =>
  lookupMatrixBid('c-1', payload, createLeadSupabaseClient(env, { fetch: db.fetch }), { kv: kv as unknown as KVNamespace, now: () => nowMs })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the bid matrix last-good copy (#1849)', () => {
  it('a healthy lookup bids as before and keeps a copy of the config and its rows, stamped as confirmed now', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    const r = await lookup(db, kv, T0)
    expect(r).toMatchObject({ bid: 50, matched_row: { id: 'r2' }, config_id: 'c-1' })
    expect(r).not.toHaveProperty('served_from')
    const held = kv.store.get(bidMatrixLastGoodKey('c-1', false))!
    expect(JSON.parse(held.value)).toEqual({ config: CONFIG, rows: ROWS })
    expect(held.metadata).toEqual({ confirmed_at: new Date(T0).toISOString() })
  })

  it('with the database refusing, the bid comes from the copy after one request, and says so', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    await lookup(db, kv, T0)
    db.state.down = true
    const before = db.state.calls
    const r = await lookup(db, kv, T0 + 60_000)
    expect(r).toMatchObject({ bid: 50, matched_row: { id: 'r2' }, served_from: 'last_good' })
    expect(db.state.calls - before).toBe(1)
  })

  it('a rows read that fails after the config answered also takes the copy, whole', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    await lookup(db, kv, T0)
    db.state.rowsDown = true
    const r = await lookup(db, kv, T0 + 60_000)
    expect(r).toMatchObject({ bid: 50, served_from: 'last_good' })
  })

  it('a copy past the thirty minute limit is refused by name', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    await lookup(db, kv, T0)
    db.state.down = true
    const run = lookup(db, kv, T0 + STORED_COPY_MAX_AGE_MS + 1)
    await expect(run).rejects.toBeInstanceOf(StoredCopyRefusedError)
    await expect(run).rejects.toMatchObject({ reason: 'copy_too_old', copy: 'bid_matrix' })
  })

  it('a failed read with no copy names the failure, never calls the config missing (L11)', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    db.state.down = true
    await expect(lookup(db, fakeKv(), T0)).rejects.toThrow(/partner_bid_config c-1 could not be read .*no stored copy/)
  })

  it('a config that is genuinely gone is refused as not found, and its copy removed, never served', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    await lookup(db, kv, T0)
    db.tables.config = null
    await expect(lookup(db, kv, T0 + 60_000)).rejects.toThrow('partner_bid_config not found: c-1')
    expect(kv.store.has(bidMatrixLastGoodKey('c-1', false))).toBe(false)
  })

  it('an inactive config is copied as inactive, so an outage keeps it switched off', async () => {
    const db = database({ config: { ...CONFIG, is_active: false }, rows: ROWS })
    const kv = fakeKv()
    expect(await lookup(db, kv, T0)).toMatchObject({ bid: null, reason: 'config_inactive' })
    db.state.down = true
    expect(await lookup(db, kv, T0 + 60_000)).toMatchObject({ bid: null, reason: 'config_inactive', served_from: 'last_good' })
  })

  it('rewrites the copy when the matrix changed or the copy is due to be confirmed, and not for every lead', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    const key = bidMatrixLastGoodKey('c-1', false)
    const writes = () => kv.puts.filter((k) => k === key).length
    await lookup(db, kv, T0)
    await lookup(db, kv, T0 + 60_000)
    expect(writes()).toBe(1)
    db.tables.rows = [ROWS[0], { ...ROWS[1], bid_amount: 55 }]
    await lookup(db, kv, T0 + 120_000)
    expect(writes()).toBe(2)
    await lookup(db, kv, T0 + 120_000 + STORED_COPY_RECONFIRM_AFTER_MS)
    expect(writes()).toBe(3)
  })

  it('keeps the sell off side apart from the offer side', async () => {
    const db = database({ config: CONFIG, rows: ROWS })
    const kv = fakeKv()
    await lookupMatrixBid('c-1', LEAD, createLeadSupabaseClient(env, { fetch: db.fetch }), { use_sell_off: true, kv: kv as unknown as KVNamespace, now: () => T0 })
    expect(kv.store.has(bidMatrixLastGoodKey('c-1', true))).toBe(true)
    expect(kv.store.has(bidMatrixLastGoodKey('c-1', false))).toBe(false)
  })
})
