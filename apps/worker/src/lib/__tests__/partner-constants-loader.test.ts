/**
 * Partner constants loader / KV cache
 * Cache hit skips Supabase, cache miss fetches + stores, null columns excluded,
 * invalidate removes key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadPartnerConstants, invalidatePartnerConstantsCache, keepPartnerConstantsConfirmed, forgetPartnerConstantsMemory } from '../partner-constants-loader'
import { STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS, StoredCopyRefusedError } from '../stored-copy-age'

const ORG = 'org-test'
const CACHE_KEY = `partner-constants-v2-${ORG}`

// The loader keeps a process-level memory cache; clear it between tests so each
// starts cold (otherwise a prior test's load is served from memory).
beforeEach(async () => {
  await invalidatePartnerConstantsCache(ORG, makeKv())
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKv(cached: unknown = null) {
  return {
    get: vi.fn().mockResolvedValue(cached),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace
}

function makeSupabase(uuidRows: unknown[] = [], partnerRows: unknown[] = []) {
  const makeChain = (rows: unknown[]) => {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'select') return () => chain
        if (prop === 'eq') return () => Promise.resolve({ data: rows, error: null })
        return () => chain
      },
    })
    return chain
  }

  let callCount = 0
  return {
    from: vi.fn().mockImplementation(() => {
      // First call = partner_uuid_map, second call = partner_configs
      return makeChain(callCount++ === 0 ? uuidRows : partnerRows)
    }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadPartnerConstants', () => {
  it('returns cached value and skips Supabase on cache hit', async () => {
    const cached = {
      subAccountIdsMap: { 'uuid-1': 'sofi' },
      sellOff: {},
      clickUrls: {},
      slugsById: { 'p-sofi': 'sofi' },
    }
    const kv = makeKv(cached)
    const sb = makeSupabase()

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result).toEqual(cached)
    expect(kv.get).toHaveBeenCalledWith(CACHE_KEY, 'json')
    expect(sb.from).not.toHaveBeenCalled()
  })

  it('fetches from Supabase on cache miss and builds subAccountIdsMap', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase(
      [{ uuid: 'uuid-1', partner_slug: 'sofi' }, { uuid: 'uuid-2', partner_slug: 'nerdwallet' }],
      []
    )

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.subAccountIdsMap).toEqual({ 'uuid-1': 'sofi', 'uuid-2': 'nerdwallet' })
    expect(sb.from).toHaveBeenCalledWith('partner_uuid_map')
  })

  it('stores combined result in KV with 300s TTL after cache miss', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [])

    await loadPartnerConstants(ORG, kv, sb as never)

    expect(kv.put).toHaveBeenCalledWith(
      CACHE_KEY,
      expect.any(String),
      { expirationTtl: 60 * 60 * 24 * 30 }
    )
  })

  it('includes sell-off copy only for partners that have it', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'sofi', sell_off_offer_title: 'SoFi Sell Off', sell_off_offer_details: '<p>details</p>', click_url: null },
      { slug: 'nerdwallet', sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.sellOff).toHaveProperty('sofi')
    expect(result.sellOff.sofi).toEqual({ title: 'SoFi Sell Off', details: '<p>details</p>' })
    expect(result.sellOff).not.toHaveProperty('nerdwallet')
  })

  it('includes click URLs only for partners that have them', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'tripoint', sell_off_offer_title: null, sell_off_offer_details: null, click_url: 'https://trypennie.com/portal/tpl' },
      { slug: 'sofi', sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.clickUrls).toHaveProperty('tripoint', 'https://trypennie.com/portal/tpl')
    expect(result.clickUrls).not.toHaveProperty('sofi')
  })

  it('UUID rows with no matching partner config still appear in subAccountIdsMap', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase(
      [{ uuid: 'uuid-orphan', partner_slug: 'unknown-partner' }],
      [] // no matching partner_configs row
    )

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.subAccountIdsMap['uuid-orphan']).toBe('unknown-partner')
  })

  it('returns empty maps when both tables return no rows', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result).toEqual({ subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {}, slugsById: {} })
  })

  it('builds activeBidding from partner_configs.is_active', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'sofi',       is_active: true,  sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
      { slug: 'nerdwallet', is_active: false, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
      { slug: 'dot818',     is_active: true,  sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.activeBidding).toEqual({ sofi: true, nerdwallet: false, dot818: true })
  })

  it('builds subAccountMinBids only for partners with non-empty maps', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'lendswift', is_active: true,  sell_off_offer_title: null, sell_off_offer_details: null, click_url: null, sub_account_min_bids: { 'uuid-a': 9.23, 'uuid-b': 3.85 } },
      { slug: 'sofi',      is_active: true,  sell_off_offer_title: null, sell_off_offer_details: null, click_url: null, sub_account_min_bids: null },
      { slug: 'empty',     is_active: true,  sell_off_offer_title: null, sell_off_offer_details: null, click_url: null, sub_account_min_bids: {} },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.subAccountMinBids).toEqual({ lendswift: { 'uuid-a': 9.23, 'uuid-b': 3.85 } })
    expect(result.subAccountMinBids).not.toHaveProperty('sofi')
    expect(result.subAccountMinBids).not.toHaveProperty('empty')
  })

  it('coerces stringy numbers in sub_account_min_bids and drops non-numeric', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'lendswift', is_active: true, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
        sub_account_min_bids: { 'uuid-a': '9.23', 'uuid-b': 'not-a-number', 'uuid-c': 3.08 } },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.subAccountMinBids.lendswift).toEqual({ 'uuid-a': 9.23, 'uuid-c': 3.08 })
  })

  it('drops 0 / negative sub-account floors (a $0 floor would bypass the partner min_bid)', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'lendswift', is_active: true, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
        sub_account_min_bids: { 'uuid-zero': 0, 'uuid-neg': -5, 'uuid-real': 4.5 } },
      { slug: 'allzero', is_active: true, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null,
        sub_account_min_bids: { 'uuid-x': 0 } },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.subAccountMinBids.lendswift).toEqual({ 'uuid-real': 4.5 })
    // a partner whose only floor was 0 ends up with no floors at all
    expect(result.subAccountMinBids).not.toHaveProperty('allzero')
  })

  it('treats null/missing is_active as inactive (safe-by-default)', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [
      { slug: 'partial', is_active: null, sell_off_offer_title: null, sell_off_offer_details: null, click_url: null },
    ])

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result.activeBidding.partial).toBe(false)
  })
})

describe('loadPartnerConstants — memory cache + single-flight', () => {
  it('serves a second call from memory without touching KV', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])

    const first = await loadPartnerConstants(ORG, kv, sb as never)
    const second = await loadPartnerConstants(ORG, kv, sb as never)

    expect(second).toEqual(first)
    expect(kv.get).toHaveBeenCalledTimes(1) // only the first call hit KV
    expect(sb.from).toHaveBeenCalledTimes(2) // 2 tables, once total
  })

  it('coalesces concurrent cold loads into a single KV/DB read', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])

    const [a, b, c] = await Promise.all([
      loadPartnerConstants(ORG, kv, sb as never),
      loadPartnerConstants(ORG, kv, sb as never),
      loadPartnerConstants(ORG, kv, sb as never),
    ])

    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(kv.get).toHaveBeenCalledTimes(1)
    expect(sb.from).toHaveBeenCalledTimes(2) // partner_uuid_map + partner_configs, once
  })

  it('a load failure is not memoized — the next call retries', async () => {
    const kv = {
      get: vi.fn().mockRejectedValueOnce(new Error('KV down')).mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace
    const sb = makeSupabase([], [])

    await expect(loadPartnerConstants(ORG, kv, sb as never)).rejects.toThrow('KV down')
    // second call should not return a cached failure — it loads fresh
    const result = await loadPartnerConstants(ORG, kv, sb as never)
    expect(result.subAccountIdsMap).toEqual({})
    expect(kv.get).toHaveBeenCalledTimes(2)
  })

  it('invalidate clears the memory copy so the next load refetches', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])

    await loadPartnerConstants(ORG, kv, sb as never)
    await invalidatePartnerConstantsCache(ORG, kv)
    await loadPartnerConstants(ORG, kv, sb as never)

    expect(kv.get).toHaveBeenCalledTimes(2) // memory cleared, so KV read again
  })
})

// A KV mock whose stored values differ per key (so the last-good copy can be
// distinguished from the short cache).
/**
 * A KV whose entries carry metadata as KV keeps it beside the value. An entry
 * given as `{ value, metadata }` is held with that metadata (#1847); any other
 * is a bare value with none, as a copy written before #1847 is.
 */
function makeKvByKey(store: Record<string, unknown>) {
  const held = (key: string) => {
    const e = store[key]
    if (e && typeof e === 'object' && 'metadata' in (e as object)) return e as { value: unknown; metadata: unknown }
    return { value: e ?? null, metadata: null }
  }
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(held(key).value)),
    getWithMetadata: vi.fn().mockImplementation((key: string) => {
      const { value, metadata } = held(key)
      return Promise.resolve({ value: value === null ? null : JSON.stringify(value), metadata })
    }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace
}

/** A last-good copy as a load `ageMs` ago left it. */
const confirmed = (value: unknown, ageMs = 0) => ({ value, metadata: { confirmed_at: new Date(Date.now() - ageMs).toISOString() } })

// Supabase whose queries resolve with a DB error (the #391 transient-blip shape).
function makeSupabaseError() {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'eq') return () => Promise.resolve({ data: null, error: { message: 'pool timeout' } })
      return () => chain
    },
  })
  return { from: vi.fn().mockReturnValue(chain) }
}

const LASTGOOD_KEY = `partner-constants-v2-${ORG}-lastgood`

describe('loadPartnerConstants — DB error handling (1.1, the #391 shape)', () => {
  it('does NOT cache an empty result on a DB error; serves the last-good copy instead', async () => {
    const lastGood = { subAccountIdsMap: { 'uuid-1': 'sofi' }, sellOff: {}, clickUrls: {}, activeBidding: { sofi: true }, subAccountMinBids: {} }
    const kv = makeKvByKey({ [LASTGOOD_KEY]: confirmed(lastGood, 60_000) }) // short cache absent, last-good present
    const sb = makeSupabaseError()

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result).toEqual(lastGood)
    // Must never write the empty result under the 30-day cache key.
    expect(kv.put).not.toHaveBeenCalledWith(CACHE_KEY, expect.anything(), expect.anything())
  })

  it('throws on a DB error when there is no last-good copy (never fabricates empty constants)', async () => {
    const kv = makeKvByKey({}) // nothing cached at all
    const sb = makeSupabaseError()

    const load = loadPartnerConstants(ORG, kv, sb as never)
    await expect(load).rejects.toBeInstanceOf(StoredCopyRefusedError)
    await expect(load).rejects.toMatchObject({ reason: 'no_copy', copy: 'partner_constants' })
    expect(kv.put).not.toHaveBeenCalled()
  })

  // #1847: served for at most thirty minutes after a load last confirmed it.
  it.each([
    ['last confirmed more than thirty minutes ago', () => confirmed({ subAccountIdsMap: {} }, STORED_COPY_MAX_AGE_MS + 1_000), 'copy_too_old'],
    ['written before copies carried a confirmation time', () => ({ subAccountIdsMap: {} }), 'copy_age_unknown'],
  ] as const)('refuses a last-good copy %s, by name', async (_label, seed, reason) => {
    const kv = makeKvByKey({ [LASTGOOD_KEY]: seed() })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(loadPartnerConstants(ORG, kv, makeSupabaseError() as never)).rejects.toMatchObject({ reason, copy: 'partner_constants' })
    } finally {
      logged.mockRestore()
    }
  })

  it('writes a no-TTL last-good copy alongside the short cache on a successful load', async () => {
    const kv = makeKvByKey({})
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])

    await loadPartnerConstants(ORG, kv, sb as never)

    expect(kv.put).toHaveBeenCalledWith(CACHE_KEY, expect.any(String), { expirationTtl: 60 * 60 * 24 * 30 })
    expect(kv.put).toHaveBeenCalledWith(LASTGOOD_KEY, expect.any(String), { metadata: { confirmed_at: expect.any(String) } })
  })
})

/**
 * The 30 day cache means a lead almost never reads the database, so a load
 * alone would let the last-good copy age out within half an hour on a healthy
 * day. The per minute prewarm confirms it against the database once it is due
 * (#1847).
 */
describe('keepPartnerConstantsConfirmed (#1847)', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z')
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('reads nothing from the database while the copy was confirmed inside the reconfirm interval', async () => {
    const kv = makeKvByKey({ [LASTGOOD_KEY]: confirmed({ subAccountIdsMap: {} }, STORED_COPY_RECONFIRM_AFTER_MS - 1) })
    const sb = makeSupabase()
    expect(await keepPartnerConstantsConfirmed(ORG, kv, sb as never)).toBe('fresh')
    expect(sb.from).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it.each([
    ['due', () => confirmed({ subAccountIdsMap: {} }, STORED_COPY_RECONFIRM_AFTER_MS)],
    ['unstamped', () => ({ subAccountIdsMap: {} })],
    ['absent', () => undefined],
  ])('reads the rows and rewrites both copies, stamped now, when the copy is %s', async (_label, seed) => {
    const entry = seed()
    const kv = makeKvByKey(entry === undefined ? {} : { [LASTGOOD_KEY]: entry })
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])
    expect(await keepPartnerConstantsConfirmed(ORG, kv, sb as never)).toBe('confirmed')
    expect(kv.put).toHaveBeenCalledWith(LASTGOOD_KEY, expect.stringContaining('uuid-1'), { metadata: { confirmed_at: new Date(NOW).toISOString() } })
    expect(kv.put).toHaveBeenCalledWith(CACHE_KEY, expect.stringContaining('uuid-1'), { expirationTtl: 60 * 60 * 24 * 30 })
  })

  it('keeps the held copy, writes nothing and never throws when the read fails', async () => {
    const kv = makeKvByKey({ [LASTGOOD_KEY]: confirmed({ subAccountIdsMap: {} }, STORED_COPY_RECONFIRM_AFTER_MS) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await keepPartnerConstantsConfirmed(ORG, kv, makeSupabaseError() as never)).toBe('failed')
      expect(logged.mock.calls.flat().join(' ')).toContain('pool timeout')
    } finally {
      logged.mockRestore()
    }
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('loadPartnerConstants: the slug for each partner id (#1553)', () => {
  it('maps every partner id in the org to its current slug', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase([], [{ id: 'p-liberty', slug: 'liberty1', is_active: false }, { id: 'p-sofi', slug: 'sofi', is_active: true }])
    const result = await loadPartnerConstants(ORG, kv, sb as never)
    // Inactive partners too: a click on an earlier offer is sent after its partner stops bidding.
    expect(result.slugsById).toEqual({ 'p-liberty': 'liberty1', 'p-sofi': 'sofi' })
  })

  it('a cached copy written before the map existed is read again rather than served without it', async () => {
    const stale = { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {} }
    const kv = makeKv(stale)
    const sb = makeSupabase([], [{ id: 'p-liberty', slug: 'liberty1', is_active: true }])
    const result = await loadPartnerConstants(ORG, kv, sb as never)
    expect(sb.from).toHaveBeenCalled()
    expect(result.slugsById).toEqual({ 'p-liberty': 'liberty1' })
  })
})

describe('invalidatePartnerConstantsCache', () => {
  it('deletes the correct KV key', async () => {
    const kv = makeKv()

    await invalidatePartnerConstantsCache(ORG, kv)

    expect(kv.delete).toHaveBeenCalledWith(CACHE_KEY)
  })
})

// The outage drill (#1305) forgets this memory before every run, so a down run
// meets the outage rather than the constants an earlier run left in memory.
describe('forgetPartnerConstantsMemory', () => {
  it('forgets every organization, so the next load reads KV again', async () => {
    const kv = makeKv(null)
    await loadPartnerConstants('org-a', kv, makeSupabase() as never)
    await loadPartnerConstants('org-b', kv, makeSupabase() as never)
    forgetPartnerConstantsMemory()
    await loadPartnerConstants('org-a', kv, makeSupabase() as never)
    await loadPartnerConstants('org-b', kv, makeSupabase() as never)
    expect(kv.get).toHaveBeenCalledTimes(4)
  })
})
