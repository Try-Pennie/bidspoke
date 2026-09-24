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
