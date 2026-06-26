/**
 * Partner constants loader / KV cache
 * Cache hit skips Supabase, cache miss fetches + stores, null columns excluded,
 * invalidate removes key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadPartnerConstants, invalidatePartnerConstantsCache } from '../partner-constants-loader'

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

    expect(result).toEqual({ subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {} })
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
function makeKvByKey(store: Record<string, unknown>) {
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store[key] ?? null)),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace
}

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
    const kv = makeKvByKey({ [LASTGOOD_KEY]: lastGood }) // short cache absent, last-good present
    const sb = makeSupabaseError()

    const result = await loadPartnerConstants(ORG, kv, sb as never)

    expect(result).toEqual(lastGood)
    // Must never write the empty result under the 30-day cache key.
    expect(kv.put).not.toHaveBeenCalledWith(CACHE_KEY, expect.anything(), expect.anything())
  })

  it('throws on a DB error when there is no last-good copy (never fabricates empty constants)', async () => {
    const kv = makeKvByKey({}) // nothing cached at all
    const sb = makeSupabaseError()

    await expect(loadPartnerConstants(ORG, kv, sb as never)).rejects.toThrow()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('writes a no-TTL last-good copy alongside the short cache on a successful load', async () => {
    const kv = makeKvByKey({})
    const sb = makeSupabase([{ uuid: 'uuid-1', partner_slug: 'sofi' }], [])

    await loadPartnerConstants(ORG, kv, sb as never)

    expect(kv.put).toHaveBeenCalledWith(CACHE_KEY, expect.any(String), { expirationTtl: 60 * 60 * 24 * 30 })
    expect(kv.put).toHaveBeenCalledWith(LASTGOOD_KEY, expect.any(String))
  })
})

describe('invalidatePartnerConstantsCache', () => {
  it('deletes the correct KV key', async () => {
    const kv = makeKv()

    await invalidatePartnerConstantsCache(ORG, kv)

    expect(kv.delete).toHaveBeenCalledWith(CACHE_KEY)
  })
})
