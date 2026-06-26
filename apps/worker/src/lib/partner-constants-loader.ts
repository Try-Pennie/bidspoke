import type { SupabaseClient } from '@supabase/supabase-js'

// Partner constants change rarely and every mutating route busts this cache
// explicitly (see invalidatePartnerConstantsCache call sites). The long TTL keeps
// the Constants node off the cold-DB path; it's finite only as a self-healing
// backstop so a missed invalidation can't leave bidding data (activeBidding,
// sub_account_min_bids) stale forever.
const TTL = 60 * 60 * 24 * 30 // 30 days (KV)
const cacheKey = (orgId: string) => `partner-constants-v2-${orgId}`
// No-TTL last-good copy, served during a transient DB blip so a cold load never
// degrades to empty bidding constants (the #391 shape — see loadFromKvOrDb).
const lastGoodKey = (orgId: string) => `partner-constants-v2-${orgId}-lastgood`

// In front of KV sits a per-isolate memory cache + single-flight. A warm isolate
// serves from memory without touching KV (sub-ms), and concurrent loads on a cold
// isolate coalesce to one KV/DB read instead of stampeding Supabase — the failure
// mode behind the constants-node burst timeouts (cold KV miss -> slow Supabase).
// The TTL is deliberately short: invalidatePartnerConstantsCache busts KV on every
// partner/uuid edit but cannot reach other isolates' memory, so this bounds how
// long a warm isolate can serve a pre-edit copy of bidding-critical data
// (activeBidding, sub_account_min_bids). It only needs to outlast a traffic burst.
const MEMORY_TTL_MS = 15_000
const memoryCache = new Map<string, { value: PartnerConstants; expiresAt: number }>()
const inflight = new Map<string, Promise<PartnerConstants>>()

export interface PartnerConstants {
  subAccountIdsMap: Record<string, string>
  sellOff: Record<string, { title: string; details: string }>
  clickUrls: Record<string, string>
  /** Bidding active per partner slug. Missing slug = inactive (safe-by-default). */
  activeBidding: Record<string, boolean>
  /** Per-partner per-sub-account minimum bid floors. Partner slug → uuid → floor. */
  subAccountMinBids: Record<string, Record<string, number>>
}

export async function loadPartnerConstants(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<PartnerConstants> {
  const memo = memoryCache.get(orgId)
  if (memo && memo.expiresAt > Date.now()) return memo.value

  const existing = inflight.get(orgId)
  if (existing) return existing

  const load = (async () => {
    try {
      const value = await loadFromKvOrDb(orgId, kv, supabase)
      memoryCache.set(orgId, { value, expiresAt: Date.now() + MEMORY_TTL_MS })
      return value
    } finally {
      inflight.delete(orgId)
    }
  })()
  inflight.set(orgId, load)
  return load
}

async function loadFromKvOrDb(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<PartnerConstants> {
  const cached = await kv.get<PartnerConstants>(cacheKey(orgId), 'json')
  if (cached) return cached

  const [uuidRes, partnerRes] = await Promise.all([
    supabase
      .from('partner_uuid_map')
      .select('uuid, partner_slug')
      .eq('org_id', orgId),
    supabase
      .from('partner_configs')
      .select('slug, sell_off_offer_title, sell_off_offer_details, click_url, is_active, sub_account_min_bids')
      .eq('organization_id', orgId),
  ])

  // A transient DB error must NEVER be turned into empty bidding constants and
  // cached for 30 days — that silently marks every partner inactive, drops bids,
  // and breaks routing with no signal (the #391 outage shape, the same mistake
  // env-loader.ts was fixed for). On error: do not cache; serve the no-TTL
  // last-good copy if we have one, else throw so the Constants node surfaces a
  // real failure instead of fabricating empty data.
  if (uuidRes.error || partnerRes.error) {
    const msg = (uuidRes.error ?? partnerRes.error)?.message
    console.error(`[partner-constants] load failed for org ${orgId}, not caching: ${msg}`)
    const lastGood = await kv.get<PartnerConstants>(lastGoodKey(orgId), 'json')
    if (lastGood) return lastGood
    throw new Error(`partner_constants load failed for org ${orgId}: ${msg}`)
  }

  const { data: uuidRows } = uuidRes
  const { data: partnerRows } = partnerRes

  const subAccountIdsMap: Record<string, string> = {}
  for (const row of uuidRows ?? []) {
    subAccountIdsMap[row.uuid] = row.partner_slug
  }

  const sellOff: Record<string, { title: string; details: string }> = {}
  const clickUrls: Record<string, string> = {}
  const activeBidding: Record<string, boolean> = {}
  const subAccountMinBids: Record<string, Record<string, number>> = {}
  for (const row of partnerRows ?? []) {
    if (row.sell_off_offer_title || row.sell_off_offer_details) {
      sellOff[row.slug] = {
        title: row.sell_off_offer_title ?? '',
        details: row.sell_off_offer_details ?? '',
      }
    }
    if (row.click_url) {
      clickUrls[row.slug] = row.click_url
    }
    activeBidding[row.slug] = row.is_active === true
    if (row.sub_account_min_bids && typeof row.sub_account_min_bids === 'object') {
      const normalized: Record<string, number> = {}
      for (const [uuid, bid] of Object.entries(row.sub_account_min_bids as Record<string, unknown>)) {
        const n = Number(bid)
        // A 0 (or negative) floor means "accept anything" and would bypass the
        // partner-wide min_bid — never an intended override. Drop it as no floor,
        // backstopping any 0 already persisted by the old blank-input bug.
        if (Number.isFinite(n) && n > 0) normalized[uuid] = n
      }
      if (Object.keys(normalized).length > 0) subAccountMinBids[row.slug] = normalized
    }
  }

  const result: PartnerConstants = { subAccountIdsMap, sellOff, clickUrls, activeBidding, subAccountMinBids }
  const serialized = JSON.stringify(result)
  // Short cache for the hot path; no-TTL last-good for blip resilience (overwritten
  // by the next successful load, so it can't go stale while edits keep flowing).
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: TTL })
  await kv.put(lastGoodKey(orgId), serialized)
  return result
}

export async function invalidatePartnerConstantsCache(orgId: string, kv: KVNamespace): Promise<void> {
  // Clears this isolate's memory copy too; other isolates self-heal within MEMORY_TTL_MS.
  memoryCache.delete(orgId)
  inflight.delete(orgId)
  await kv.delete(cacheKey(orgId))
}
