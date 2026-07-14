/**
 * How many partners a Bid Group can actually call (#645).
 *
 * The card counted `partner_ids` (or the tiers' ids) and ignored
 * `fallback_partner_id`, which the engine calls when nobody wins
 * (bid-group.ts). A group with two partners and a fallback advertised
 * "2 partners" while three could be hit, on the node where bidding money moves.
 */
export function bidGroupPartnerSummary(config: Record<string, unknown>): string {
  const mode = config.mode as string | undefined
  const partnerIds = (config.partner_ids as string[] | undefined) ?? []
  const tiers = (config.tiers as Array<{ partner_ids?: string[] }> | undefined) ?? []

  const count =
    mode === 'tiered'
      ? tiers.reduce((sum, t) => sum + (t.partner_ids?.length ?? 0), 0)
      : partnerIds.length
  const hasFallback = Boolean(config.fallback_partner_id)

  if (count === 0) return hasFallback ? 'Fallback partner only' : 'No partners configured'
  const partners = `${count} partner${count === 1 ? '' : 's'}`
  return hasFallback ? `${partners} + fallback` : partners
}
