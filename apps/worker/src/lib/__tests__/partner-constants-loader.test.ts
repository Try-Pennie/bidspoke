/**
 * Partner constants loader / KV cache
 * Cache hit skips Supabase, cache miss fetches + stores, null columns excluded,
 * invalidate removes key.
 */
import { describe, it, expect, vi } from 'vitest'
import { loadPartnerConstants, invalidatePartnerConstantsCache } from '../partner-constants-loader'

const ORG = 'org-test'
const CACHE_KEY = `partner-constants-${ORG}`

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
      { expirationTtl: 300 }
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

    expect(result).toEqual({ subAccountIdsMap: {}, sellOff: {}, clickUrls: {} })
  })
})

describe('invalidatePartnerConstantsCache', () => {
  it('deletes the correct KV key', async () => {
    const kv = makeKv()

    await invalidatePartnerConstantsCache(ORG, kv)

    expect(kv.delete).toHaveBeenCalledWith(CACHE_KEY)
  })
})
