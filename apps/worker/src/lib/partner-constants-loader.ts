import type { SupabaseClient } from '@supabase/supabase-js'

const TTL = 300
const cacheKey = (orgId: string) => `partner-constants-v2-${orgId}`

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
  const cached = await kv.get<PartnerConstants>(cacheKey(orgId), 'json')
  if (cached) return cached

  const [{ data: uuidRows }, { data: partnerRows }] = await Promise.all([
    supabase
      .from('partner_uuid_map')
      .select('uuid, partner_slug')
      .eq('org_id', orgId),
    supabase
      .from('partner_configs')
      .select('slug, sell_off_offer_title, sell_off_offer_details, click_url, is_active, sub_account_min_bids')
      .eq('organization_id', orgId),
  ])

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
        if (Number.isFinite(n)) normalized[uuid] = n
      }
      if (Object.keys(normalized).length > 0) subAccountMinBids[row.slug] = normalized
    }
  }

  const result: PartnerConstants = { subAccountIdsMap, sellOff, clickUrls, activeBidding, subAccountMinBids }
  await kv.put(cacheKey(orgId), JSON.stringify(result), { expirationTtl: TTL })
  return result
}

export async function invalidatePartnerConstantsCache(orgId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(cacheKey(orgId))
}
