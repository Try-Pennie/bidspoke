/**
 * The buyer_click_send node's over cap percent (#1542, #1553): the one rule the
 * executor and save validation both read, so a value the node would refuse on
 * every run cannot be saved first.
 *
 * The over cap notice fires once the day's clicks reach this percent of the
 * daily cap (60 at a cap of 50 with the default). Absent (undefined or null)
 * means the default; anything else must be a whole number from 1 to 1000. A
 * numeric string is refused rather than coerced, because the form stores a
 * number and a string means the config was written some other way.
 */

/**
 * The cap rule every cap reader shares (#1557): a whole number above zero.
 * validateProfile refuses anything else on save, and buyer_click_check and
 * buyer_click_send treat anything else as no readable cap, so a cap of zero
 * (which would judge every click over the cap) can neither be saved nor
 * honoured.
 */
export function isCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * buyer_click_check's whole budget, the profile load and the count read
 * together (#1543). It sits on Engine's synchronous response path, and a warm
 * run is a KV hit plus one Durable Object read (about 25 ms warm, #1428). Here
 * rather than in the executor so the node form states the same number.
 *
 * 800 ms since 2026-09-29, the first live day: at 300 ms an eligible Liberty1
 * lead missed its offer when the profile read took about 250 ms and the counter
 * answer landed just past the deadline. 800 ms matches buyer_select's own
 * budget. It still does not cover the counter's cold p99 (1,492 ms, #1557), so
 * a cold start can cost the odd offer, counted by the check error share.
 */
export const CLICK_CHECK_BUDGET_MS = 800

/**
 * The oldest a last good copy of the buyer profiles may be for buyer_click_check
 * to still offer from it (#1557). The copy is served only when the database read
 * fails; past this it may miss a buyer switched off or a cap lowered since, so
 * the check routes not eligible (profile_copy_stale) rather than offer on it.
 * Fifteen minutes rides out a short database wobble without offering for long
 * on rules nobody can confirm.
 */
export const CLICK_CHECK_LAST_GOOD_MAX_AGE_MS = 15 * 60 * 1000

/**
 * The placeholder a click buyer's click URL must carry (#1546). The Engine offer
 * script (build_response_body) replaces it with the created prospect's id, and
 * refuses a URL without it as click_url_has_no_prospect_id, so a buyer enabled
 * with such a URL would be switched on and never offered. validateProfile refuses
 * enabling one and buyer_click_check routes it not eligible and pages; both read
 * this one rule. The canvas script is a pasted literal and cannot import it, so
 * it spells the same string, which its own tests pin.
 */
export const CLICK_URL_PROSPECT_PLACEHOLDER = '{prospect_id}'

/**
 * The one sentence for a click URL without the placeholder, said on the Click URL
 * field by validateProfile when enabling a click buyer and by the partner save
 * when breaking the URL of one already enabled (#1561), so the two refusals read
 * the same.
 */
export const CLICK_URL_NO_PROSPECT_ID_MESSAGE = `Put ${CLICK_URL_PROSPECT_PLACEHOLDER} in the click URL where the prospect's id goes. Without it no offer can be made to this buyer.`

/** True when the value is a click URL carrying the prospect id placeholder. */
export function clickUrlCarriesProspectId(value: unknown): boolean {
  return typeof value === 'string' && value.includes(CLICK_URL_PROSPECT_PLACEHOLDER)
}

export const DEFAULT_ALERT_OVER_PERCENT = 120
export const ALERT_OVER_PERCENT_MIN = 1
export const ALERT_OVER_PERCENT_MAX = 1000

export type AlertOverPercent = { ok: true; percent: number } | { ok: false; reason: string }

export function alertOverPercentOf(value: unknown): AlertOverPercent {
  if (value === undefined || value === null) return { ok: true, percent: DEFAULT_ALERT_OVER_PERCENT }
  if (typeof value === 'number' && Number.isInteger(value) && value >= ALERT_OVER_PERCENT_MIN && value <= ALERT_OVER_PERCENT_MAX) {
    return { ok: true, percent: value }
  }
  // String for a number, so NaN and Infinity are named rather than printed as null.
  const shown = typeof value === 'number' ? String(value) : JSON.stringify(value)
  return { ok: false, reason: `alert_over_percent ${shown} is not a whole number from ${ALERT_OVER_PERCENT_MIN} to ${ALERT_OVER_PERCENT_MAX}` }
}

/**
 * The click nodes' partner id rule (#1543): buyer_click_send and
 * buyer_click_check name their buyer by its partner_configs id (a uuid), and
 * the executors and save validation all read this one rule, so a value the
 * node would refuse on every run cannot be saved first. A slug never has this
 * shape, so a slug stored where the id belongs is refused rather than opening a
 * different, empty object (#1553, L15).
 */
const PARTNER_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when the value has the shape of a partner_configs id, exactly as given. */
export function isPartnerId(value: unknown): value is string {
  return typeof value === 'string' && PARTNER_ID_SHAPE.test(value)
}

export type PartnerIdRule = { ok: true; id: string } | { ok: false; reason: string }

/** A node's stored partner_id, trimmed, or the reason it is not one. */
export function partnerIdOf(value: unknown): PartnerIdRule {
  const trimmed = typeof value === 'string' ? value.trim() : value
  if (isPartnerId(trimmed)) return { ok: true, id: trimmed }
  return { ok: false, reason: `partner_id ${JSON.stringify(value ?? null)} is not a partner id; pick the buyer again on the node` }
}

/**
 * Why a click claim is held for a person (#1552): the reasons buyer_click_send
 * records a held claim under, in the order the partner page explains them. The
 * held_click_claims CHECK constraint lists exactly these (a worker test reads the
 * migration), and each is also a page reason, so the Slack page and the partner
 * page speak of one set.
 */
export const HELD_CLICK_REASONS = ['outcome_unknown', 'sold_mark_failed', 'free_failed', 'claim_in_doubt'] as const
export type HeldClickReason = (typeof HELD_CLICK_REASONS)[number]

/** What each reason means for the person deciding, in the domain's words. */
export const HELD_CLICK_REASON_LABELS: Record<HeldClickReason, string> = {
  outcome_unknown: 'The buyer gave no readable answer, so whether it created the lead is not known.',
  sold_mark_failed: 'The buyer created the lead, and recording that failed.',
  free_failed: 'The buyer refused the lead, and releasing the claim failed.',
  claim_in_doubt: 'An earlier send never recorded its outcome.',
}
