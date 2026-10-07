/**
 * The latency gate's partner threshold in a database outage (#1849).
 *
 * A check node without its own threshold reads the partner's
 * confirmation_window_ms from partner_configs on every confirmation. That read
 * had no copy behind it, so in an outage every confirmation threw. It now reads
 * the partner config the way partner_bid does, through the one partner read and
 * the one partner last-good copy (lib/partner-last-good.ts), which every
 * partner route retires on a change, the stored copy sweep keeps confirmed, and
 * the thirty minute limit governs.
 *
 * The real supabase-js client runs throughout; only the network beneath it is
 * replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../../index'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import { executeLatencyGateNode } from '../latency-gate'
import { createLeadSupabaseClient } from '../../../lib/lead-read-budget'
import { partnerLastGoodKey, retirePartnerLastGood } from '../../../lib/partner-last-good'
import { STORED_COPY_MAX_AGE_MS, StoredCopyRefusedError } from '../../../lib/stored-copy-age'

const NOW = Date.UTC(2026, 9, 7, 12)
const dbEnv = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const PARTNER = { id: 'p-le', slug: 'lead_economy', is_active: true, confirmation_window_ms: 4000, updated_at: '2026-10-01T00:00:00+00:00' }

function fakeKv() {
  const store = new Map<string, { value: string; metadata: unknown }>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
    getWithMetadata: vi.fn(async (k: string) => ({ value: store.get(k)?.value ?? null, metadata: store.get(k)?.metadata ?? null })),
    put: vi.fn(async (k: string, value: string, opts?: { metadata?: unknown }) => { store.set(k, { value, metadata: opts?.metadata ?? null }) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

/** A network answering partner_configs with `row` (null: no such partner) while up, refusing while down. */
function database(row: Record<string, unknown> | null) {
  const state = { down: false, calls: 0 }
  const fetch = (async (input: RequestInfo | URL) => {
    state.calls++
    if (state.down) throw new TypeError('fetch failed')
    if (row === null) {
      return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows', hint: null }), { status: 406, headers: { 'content-type': 'application/json' } })
    }
    // Only the columns the read asks for, as PostgREST answers.
    const cols = (new URL(String(input)).searchParams.get('select') ?? '*').split(',').map((c) => c.trim())
    const body = cols.includes('*') ? row : Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k)))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { state, fetch }
}

function envWith(kv: ReturnType<typeof fakeKv>, markedAt: number): Env {
  const marks = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => new Response(JSON.stringify({ marked_at: markedAt })) }) }
  return { LATENCY_MARK: marks, WORKFLOW_CACHE: kv } as unknown as Env
}

const ctx = { trigger: { payload: { lead_id: 'lead-1' }, source: 'le', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 't-1' }, steps: {}, env: {} } as unknown as ExecutionContext
const check: NodeDefinition = { id: 'n1', namespace: 'gate', type: 'latency_gate', config: { operation: 'check', correlation_key: 'lead-1', partner_id: PARTNER.id } }

beforeEach(async () => {
  // Forget this isolate's record of the copies earlier cases wrote, as a fresh isolate would.
  await retirePartnerLastGood(undefined, PARTNER.id)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

async function warm(kv: ReturnType<typeof fakeKv>, db: ReturnType<typeof database>) {
  const r = await executeLatencyGateNode(check, ctx, envWith(kv, NOW - 1000), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))
  expect(r.output).toMatchObject({ threshold_ms: 4000, _route: 'within' })
}

describe('the latency gate threshold in a database outage (#1849)', () => {
  it('a healthy read keeps the partner copy, holding the confirmation window', async () => {
    const kv = fakeKv()
    const db = database(PARTNER)
    await warm(kv, db)
    expect(db.state.calls).toBe(1)
    const held = kv.store.get(partnerLastGoodKey(PARTNER.id))
    expect(JSON.parse(held!.value)).toMatchObject({ id: PARTNER.id, confirmation_window_ms: 4000 })
    expect(held!.metadata).toEqual({ confirmed_at: new Date(NOW).toISOString() })
  })

  it('with the database refusing, the threshold comes from the copy after one request', async () => {
    const kv = fakeKv()
    const db = database(PARTNER)
    await warm(kv, db)
    db.state.down = true
    const before = db.state.calls
    const r = await executeLatencyGateNode(check, ctx, envWith(kv, NOW - 5000), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))
    expect(r.output).toMatchObject({ threshold_ms: 4000, latency_ms: 5000, _route: 'exceeded', reason: 'latency_exceeded' })
    expect(db.state.calls - before).toBe(1)
  })

  it('a copy past the thirty minute limit is refused by name', async () => {
    const kv = fakeKv()
    const db = database(PARTNER)
    await warm(kv, db)
    db.state.down = true
    vi.spyOn(Date, 'now').mockReturnValue(NOW + STORED_COPY_MAX_AGE_MS + 1)
    const run = executeLatencyGateNode(check, ctx, envWith(kv, NOW), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))
    await expect(run).rejects.toBeInstanceOf(StoredCopyRefusedError)
    await expect(run).rejects.toMatchObject({ reason: 'copy_too_old', copy: 'partner_config' })
  })

  it('a partner that is genuinely gone is refused, and its copy removed, never served', async () => {
    const kv = fakeKv()
    await warm(kv, database(PARTNER))
    const gone = database(null)
    await expect(executeLatencyGateNode(check, ctx, envWith(kv, NOW - 1000), createLeadSupabaseClient(dbEnv, { fetch: gone.fetch }))).rejects.toThrow(/partner config not found: p-le/)
    expect(kv.store.has(partnerLastGoodKey(PARTNER.id))).toBe(false)
  })

  it('a failed read with no copy says the partner could not be read, never that it is not found', async () => {
    const db = database(PARTNER)
    db.state.down = true
    const run = executeLatencyGateNode(check, ctx, envWith(fakeKv(), NOW - 1000), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))
    await expect(run).rejects.toThrow(/partner config p-le could not be read .*and there is no stored copy/)
    await expect(run).rejects.not.toThrow(/not found/)
  })

  it('a copy written before it carried the confirmation window is refused by name, never read as a partner with none', async () => {
    const kv = fakeKv()
    const db = database(PARTNER)
    await warm(kv, db)
    const held = kv.store.get(partnerLastGoodKey(PARTNER.id))!
    const { confirmation_window_ms: _dropped, ...older } = JSON.parse(held.value) as Record<string, unknown>
    kv.store.set(partnerLastGoodKey(PARTNER.id), { ...held, value: JSON.stringify(older) })
    db.state.down = true
    await expect(executeLatencyGateNode(check, ctx, envWith(kv, NOW - 1000), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))).rejects.toThrow(/stored copy of partner p-le was written before it carried confirmation_window_ms/)
  })
})
