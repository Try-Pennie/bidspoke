import type { SupabaseClient } from '@supabase/supabase-js'

const TTL = 60
const cacheKey = (orgId: string) => `partner-constants-${orgId}`

export interface PartnerConstants {
  subAccountIdsMap: Record<string, string>
  sellOff: Record<string, { title: string; details: string }>
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
      .select('slug, sell_off_offer_title, sell_off_offer_details')
      .eq('organization_id', orgId),
  ])

  const subAccountIdsMap: Record<string, string> = {}
  for (const row of uuidRows ?? []) {
    subAccountIdsMap[row.uuid] = row.partner_slug
  }

  const sellOff: Record<string, { title: string; details: string }> = {}
  for (const row of partnerRows ?? []) {
    if (row.sell_off_offer_title || row.sell_off_offer_details) {
      sellOff[row.slug] = {
        title: row.sell_off_offer_title ?? '',
        details: row.sell_off_offer_details ?? '',
      }
    }
  }

  const result: PartnerConstants = { subAccountIdsMap, sellOff }
  await kv.put(cacheKey(orgId), JSON.stringify(result), { expirationTtl: TTL })
  return result
}

export async function invalidatePartnerConstantsCache(orgId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(cacheKey(orgId))
}
