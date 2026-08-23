/**
 * Partner role vocabulary (#306, ADR 0001).
 *
 * A partner is a lead `source`, a bid `buyer`, or `both`: one company can play
 * two parts at once (Engine sends us free leads inbound and bids as the fallback
 * buyer outbound), and forcing that into two partner records splits one
 * company's identity and config across rows.
 *
 * This list is the write-side half of a vocabulary the partner form also
 * renders. It is pinned to the database CHECK constraint by
 * `__tests__/partner-roles.test.ts`, which reads the migration rather than
 * trusting the two lists to have been kept in step by hand.
 */

export const PARTNER_TYPES = ['source', 'buyer', 'both'] as const

export type PartnerType = (typeof PARTNER_TYPES)[number]

export function isPartnerType(value: unknown): value is PartnerType {
  return typeof value === 'string' && (PARTNER_TYPES as readonly string[]).includes(value)
}

/** True when the partner can receive bids (bidding, caps, circuit breaker). */
export function isBuyerPartner(partnerType: PartnerType): boolean {
  return partnerType === 'buyer' || partnerType === 'both'
}

/** True when the partner sends us leads (sell-off copy, sub-account UUIDs). */
export function isSourcePartner(partnerType: PartnerType): boolean {
  return partnerType === 'source' || partnerType === 'both'
}
