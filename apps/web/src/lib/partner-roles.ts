/**
 * Partner roles (#306, ADR 0001).
 *
 * `partner_type` was an exclusive source | buyer, but a real company can play
 * both parts at once: Engine supplies free leads inbound AND acts as the
 * fallback buyer outbound. Rather than force two partner records for one
 * company, a third value `both` carries both roles on one record.
 *
 * Callers must ask the ROLE question (may this partner receive bids, does this
 * partner send us leads) through these predicates rather than comparing
 * `partner_type` directly. A direct `=== 'buyer'` comparison silently excludes
 * `both`, which is the exact defect this value was added to avoid, and it is
 * invisible: the partner just stops appearing in a picker.
 */

export const PARTNER_TYPES = ['source', 'buyer', 'both'] as const

export type PartnerType = (typeof PARTNER_TYPES)[number]

/** True when the partner can receive bids (bidding, caps, circuit breaker). */
export function isBuyerPartner(partnerType: PartnerType): boolean {
  return partnerType === 'buyer' || partnerType === 'both'
}

/** True when the partner sends us leads (sell-off copy, sub-account UUIDs). */
export function isSourcePartner(partnerType: PartnerType): boolean {
  return partnerType === 'source' || partnerType === 'both'
}

const LABELS: Record<PartnerType, string> = {
  source: 'Source',
  buyer: 'Buyer',
  both: 'Both',
}

export function partnerTypeLabel(partnerType: PartnerType): string {
  return LABELS[partnerType]
}
