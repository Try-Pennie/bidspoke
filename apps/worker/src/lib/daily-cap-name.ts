import { easternParts } from '@bidspoke/buyer-profile'

/**
 * The daily cap object's name for a partner at an instant (#1410, L39).
 *
 * `cap-{slug}-{YYYY-MM-DD}` on the EASTERN day, through the one clock the buyer
 * profiles use, so a partner's day rolls when Pennie's day does. The two call
 * sites (the Partner Bid node and the cap count route) derived this inline on
 * the UTC day; both now call here, and a guard fails on the next inline copy.
 * Behaviour neutral on the day it shipped only because no partner had a
 * daily_cap set (Phase 0 measured zero, #1407); with one set, the change lands
 * at Eastern midnight rather than UTC midnight.
 *
 * The date comes back with the name so the cap count route can say which day
 * it counted (L589).
 */
export function dailyCapObjectName(slug: string, nowMs: number): { name: string; date: string } {
  const { date } = easternParts(nowMs)
  return { name: `cap-${slug}-${date}`, date }
}
