import type { BuyerProfileDocument, SoldOn } from '@bidspoke/buyer-profile'

/**
 * What choosing a kind writes to the draft (#1541). A click buyer may carry no
 * hourly cap, no spend cap and no pricing, and the editor hides those controls
 * the moment click is chosen, so any value left in them would be refused on save
 * over a field the person can no longer see or fix (L111). Stored tiers never
 * reach here: the switch is locked while they exist.
 */
export function soldOnPatch(next: SoldOn): Partial<BuyerProfileDocument> {
  // A click delivery (#1639) is click only and hidden on an offer buyer, so the same reasoning clears it.
  if (next === 'offer') return { sold_on: 'offer', click_delivery: null }
  return {
    sold_on: 'click',
    hourly_lead_cap: null,
    hourly_spend_cap_cents: null,
    daily_spend_cap_cents: null,
    tiers: [],
  }
}
