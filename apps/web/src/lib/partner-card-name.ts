/**
 * What the Partner Bid card should say about its partner (#645).
 *
 * The card used to render `config.partner_name`, a copy of the name snapshotted
 * when the partner was picked. The engine never reads it: it resolves the
 * partner by `config.partner_id` against the live partners table
 * (partner-bid.ts). So a rename left every node asserting the old name forever,
 * and a DELETED partner still showed a confident name on a node that throws
 * "Partner config not found" the moment it runs.
 *
 * Resolving from the live list every render makes both of those states honest.
 */
export type PartnerNameTone = 'normal' | 'muted' | 'error'

export function partnerCardName({
  partnerId,
  partners,
  loaded,
}: {
  partnerId: string | undefined
  partners: Map<string, { name: string }>
  loaded: boolean
}): { text: string; tone: PartnerNameTone } {
  if (!partnerId) return { text: 'No partner selected', tone: 'error' }
  // Don't accuse a node of pointing at a missing partner before the list arrives.
  if (!loaded) return { text: '…', tone: 'muted' }
  const partner = partners.get(partnerId)
  if (!partner) return { text: 'Partner not found', tone: 'error' }
  return { text: partner.name, tone: 'normal' }
}
