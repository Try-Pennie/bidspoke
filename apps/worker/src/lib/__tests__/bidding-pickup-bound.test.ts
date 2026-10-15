/**
 * How soon bidding sees a partner change the partners page did not make
 * (#2132): a hand run UPDATE, a rename, a partner_uuid_map insert or a new
 * partner row. Nothing clears the 30 day partner constants copy for those, so
 * the per minute prewarm is what rewrites it, once its last good copy is
 * STORED_COPY_RECONFIRM_AFTER_MS old. The web constant BIDDING_PICKUP states the
 * bound this proves; apps/web/src/lib/__guards__/worker/bidding-pickup-bound.test.ts
 * re-derives it from these same constants.
 *
 * The clock is set a simulated minute at a time, never waited on (L290). A lead
 * in another isolate is a cold read of KV (forgetPartnerConstantsMemory, then
 * loadPartnerConstants); a warm isolate adds at most MEMORY_TTL_MS, and KV's
 * own propagation to other locations adds up to a minute, both of which the
 * bound includes but a single KV double cannot show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prewarmKvCaches } from '../cache-prewarm'
import { forgetPartnerConstantsMemory, loadPartnerConstants, PARTNER_CONSTANTS_MEMORY_TTL_MS } from '../partner-constants-loader'
import { STORED_COPY_RECONFIRM_AFTER_MS } from '../stored-copy-age'
import type { Env } from '../../index'

const MINUTE = 60_000
const START = Date.parse('2026-10-15T12:00:00.000Z')
/** One per minute cron tick: a reconfirm falls due between two runs of it. */
const PREWARM_TICK_MS = MINUTE
/** What a cold read in this single KV double can show: the due reconfirm plus the tick that finds it. */
const KV_BOUND_MS = STORED_COPY_RECONFIRM_AFTER_MS + PREWARM_TICK_MS

interface Rows {
  partner_configs: Array<Record<string, unknown>>
  partner_uuid_map: Array<Record<string, unknown>>
}

function fakeSupabase(rows: Rows) {
  const answer = (table: string) => {
    if (table === 'workflows') return { data: [{ id: 'wf-1', organization_id: 'org-1' }], error: null }
    if (table === 'partner_configs') return { data: rows.partner_configs.map((r) => ({ ...r })), error: null }
    if (table === 'partner_uuid_map') return { data: rows.partner_uuid_map.map((r) => ({ ...r })), error: null }
    if (table === 'buyer_profiles') return { data: [], error: null }
    return { data: null, error: { message: `table ${table} is not part of this test` } }
  }
  return {
    from(table: string) {
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(table)).then(resolve, reject)
          if (prop === 'single' || prop === 'maybeSingle') return async () => answer(table)
          return () => builder
        },
      })
      return builder
    },
    rpc: async () => ({ data: null, error: { message: 'rpc is not part of this test' } }),
  } as never
}

function fakeKv(opts: { failing?: () => boolean } = {}) {
  const store = new Map<string, { value: string; metadata?: unknown }>()
  const fail = () => { if (opts.failing?.()) throw new Error('kv unavailable') }
  const kv = {
    get: async (key: string, type?: string) => {
      const hit = store.get(key)
      if (!hit) return null
      return type === 'json' ? JSON.parse(hit.value) : hit.value
    },
    getWithMetadata: async (key: string) => {
      const hit = store.get(key)
      return { value: hit?.value ?? null, metadata: hit?.metadata ?? null }
    },
    put: async (key: string, value: string, o?: { metadata?: unknown }) => { fail(); store.set(key, { value, metadata: o?.metadata }) },
    delete: async (key: string) => { fail(); store.delete(key) },
    list: async (o?: { prefix?: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(o?.prefix ?? '')).map((name) => ({ name })), list_complete: true }),
  }
  return { kv: kv as unknown as KVNamespace, store }
}

const envOf = (cache: KVNamespace, idem: KVNamespace) =>
  ({ WORKFLOW_CACHE: cache, IDEMPOTENCY: idem, SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }) as unknown as Env

/** What a lead in a fresh isolate is served now. */
async function coldRead(cache: KVNamespace, supabase: never) {
  forgetPartnerConstantsMemory()
  return loadPartnerConstants('org-1', cache, supabase)
}

describe('bidding sees a change the page did not make within the bound (#2132)', () => {
  let logs: ReturnType<typeof vi.spyOn>
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    forgetPartnerConstantsMemory()
    logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    logs.mockRestore()
    errors.mockRestore()
  })

  /**
   * Warm the copy at START, make `change` 30 s later, then run the prewarm once
   * a simulated minute. Answers when a cold read first saw the change, measured
   * from the copy's confirmation at START.
   */
  async function pickupAfter(change: (rows: Rows) => void, seen: (c: Awaited<ReturnType<typeof loadPartnerConstants>>) => boolean): Promise<number> {
    const rows: Rows = {
      partner_configs: [{ id: 'p-1', slug: 'tripoint', is_active: true, sell_off_offer_title: 'Old', sell_off_offer_details: null, click_url: null, sub_account_min_bids: null }],
      partner_uuid_map: [],
    }
    const supabase = fakeSupabase(rows)
    const cache = fakeKv()
    const idem = fakeKv()
    await prewarmKvCaches(supabase, envOf(cache.kv, idem.kv), { notify: vi.fn(async (..._args: unknown[]) => undefined) })
    vi.setSystemTime(START + 30_000)
    change(rows)
    for (let minute = 1; minute <= 15; minute++) {
      vi.setSystemTime(START + minute * MINUTE)
      await prewarmKvCaches(supabase, envOf(cache.kv, idem.kv), { notify: vi.fn(async (..._args: unknown[]) => undefined) })
      if (seen(await coldRead(cache.kv, supabase))) return Date.now() - START
    }
    return Number.POSITIVE_INFINITY
  }

  const cases: Array<[string, (rows: Rows) => void, (c: Awaited<ReturnType<typeof loadPartnerConstants>>) => boolean]> = [
    ['a constants column changed by hand', (rows) => { rows.partner_configs[0].sell_off_offer_title = 'New' }, (c) => c.sellOff.tripoint?.title === 'New'],
    ['a partner_uuid_map insert', (rows) => { rows.partner_uuid_map.push({ uuid: 'sub-1', partner_slug: 'tripoint' }) }, (c) => c.subAccountIdsMap['sub-1'] === 'tripoint'],
    ['a partner row insert', (rows) => { rows.partner_configs.push({ id: 'p-2', slug: 'liberty1', is_active: true, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null, sub_account_min_bids: null }) },
      (c) => c.activeBidding.liberty1 === true && c.slugsById?.['p-2'] === 'liberty1'],
  ]

  it.each(cases)('%s reaches bidding no later than the bound, and not before the reconfirm is due', async (_label, change, seen) => {
    const at = await pickupAfter(change, seen)
    expect(at).toBeLessThanOrEqual(KV_BOUND_MS)
    expect(at).toBeGreaterThanOrEqual(STORED_COPY_RECONFIRM_AFTER_MS)
  })

  it('the stated bound adds a warm isolate\'s memory and KV propagation to what one KV can show', () => {
    expect(PARTNER_CONSTANTS_MEMORY_TTL_MS).toBe(15_000)
    expect(KV_BOUND_MS + PARTNER_CONSTANTS_MEMORY_TTL_MS + MINUTE).toBeLessThanOrEqual(8 * MINUTE)
  })

  it('a save whose cache clear failed while KV refused every write is served once KV recovers, within the bound', async () => {
    let kvDown = true
    const rows: Rows = {
      partner_configs: [{ id: 'p-1', slug: 'tripoint', is_active: true, sell_off_offer_title: 'Old', sell_off_offer_details: null, click_url: null, sub_account_min_bids: null }],
      partner_uuid_map: [],
    }
    const supabase = fakeSupabase(rows)
    const cache = fakeKv({ failing: () => kvDown })
    const idem = fakeKv()
    kvDown = false
    await prewarmKvCaches(supabase, envOf(cache.kv, idem.kv), { notify: vi.fn(async (..._args: unknown[]) => undefined) })
    // The save lands in the rows while KV refuses the route's clear.
    kvDown = true
    vi.setSystemTime(START + 30_000)
    rows.partner_configs[0].is_active = false
    vi.setSystemTime(START + 2 * MINUTE)
    kvDown = false
    let seenAt = Number.POSITIVE_INFINITY
    for (let minute = 2; minute <= 15; minute++) {
      vi.setSystemTime(START + minute * MINUTE)
      await prewarmKvCaches(supabase, envOf(cache.kv, idem.kv), { notify: vi.fn(async (..._args: unknown[]) => undefined) })
      if ((await coldRead(cache.kv, supabase)).activeBidding.tripoint === false) { seenAt = Date.now() - START; break }
    }
    expect(seenAt).toBeLessThanOrEqual(KV_BOUND_MS)
  })
})
