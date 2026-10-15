/**
 * How soon bidding sees a partner change, on a healthy day (#2132, plan
 * decision 5 option A). Every sentence on any page that says when bidding sees
 * a change reads this one constant (pickupSentence), never a typed number, and
 * states the condition it holds under.
 *
 * What it bounds. A save from the partners page clears the partner constants
 * copy and rebuilds the buyer profiles copy at once, so bidding normally sees it
 * within about a minute. A change the page did not make (a hand run UPDATE, a
 * step rename, a sub-account insert, a new partner row), or a page save whose
 * cache clear failed, is picked up only by the Worker's per minute prewarm:
 * - partner constants: the 30 day copy is rewritten from the rows when its last
 *   good copy is 5 minutes old (STORED_COPY_RECONFIRM_AFTER_MS), at the next
 *   per minute tick; a warm isolate keeps its memory copy 15 s more (MEMORY_TTL_MS),
 *   and KV takes up to a minute to reach other locations;
 * - buyer profiles: the prewarm rebuilds the cached snapshot every minute (its
 *   300 s TTL is the bound if the prewarm stops), and KV propagates as above.
 *
 * Measured 2026-10-15, 13:41 to 14:26 UTC, read only through the Cloudflare API
 * (KV metadata and value reads of the production org's copies every 20 s, 127
 * samples, no errors, nothing written):
 * - partner-constants-v2-<org>-lastgood confirmed_at: 8 reconfirm cycles, gaps
 *   289 to 360 s, largest 360.2 s. 360 s + 15 s memory + 60 s propagation =
 *   435 s, so 8 minutes.
 * - buyer-profiles:<org> loaded_at: 44 rebuilds, gaps 16 to 120 s (one missed
 *   tick), largest 120.4 s. 120 s + 60 s propagation = 180 s, so 3 minutes.
 *   (The buyer profiles last good copy was reconfirmed every 300 to 359 s; that
 *   copy is only served in an outage and does not bound pickup.)
 *
 * A healthy day figure, and the copy says so. It holds for an organization with
 * an active workflow (the prewarm's selection; one with none does not bid),
 * while the per minute cron runs (its stall is alerted, #2103), and while
 * reconfirms succeed. When they fail, the 30 day copy keeps serving the old
 * constants, the failure is now logged and paged
 * (export-alert:partner-constants-reconfirm), and the ceiling is the stale copy
 * alert at 30 minutes (STORED_COPY_MAX_AGE_MS). Hence "while the database is
 * reachable", the same condition COPY_NOT_CLEARED_MESSAGE states.
 *
 * apps/web/src/lib/__guards__/worker/bidding-pickup-bound.test.ts re-derives the
 * bound from the Worker's settings and fails when it exceeds these figures, so
 * a change to any of them re-opens this copy.
 */
export const BIDDING_PICKUP = {
  partnerConstantsMinutes: 8,
  buyerProfilesMinutes: 3,
} as const

/** How long a write takes to reach other KV locations; Cloudflare documents up to 60 s. */
export const KV_PROPAGATION_MS = 60_000

/** The longer of the two, which is the honest figure for a save that may touch either. */
export const BIDDING_PICKUP_MINUTES = Math.max(BIDDING_PICKUP.partnerConstantsMinutes, BIDDING_PICKUP.buyerProfilesMinutes)

/** The one sentence about when bidding sees a saved change, with the condition it holds under. */
export function pickupSentence(): string {
  return `Bidding picks this up within about ${BIDDING_PICKUP_MINUTES} minutes while the database is reachable.`
}
