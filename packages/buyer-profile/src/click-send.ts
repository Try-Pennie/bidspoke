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
