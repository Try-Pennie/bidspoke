'use client'

/**
 * A click sold buyer's usage (#1543): the distinct clicks from its click counter
 * for the date counted, against the profile's clicks per day, the same count
 * buyer_click_check stops offering at (L16). An unreadable counter is its own
 * state with no number (L633).
 *
 * Drawn as the settled design draws it (#2324, PM-21), beside the Clicks per day
 * box: a bar and "11 of 50 clicks today". The count is for the Pacific day, so a
 * page left open past the reset names the day it read instead of calling it
 * today. Every fact once on the page (#1557, L605): when the count resets, and
 * that a buyer with no cap is not offered, are said by the caps hint under it.
 */
import { PACIFIC, zonedParts } from '@bidspoke/buyer-profile'
import { FieldError } from '@/components/ui/form'
import { formatCalendarDay } from '@/lib/dates'
import { alsoSellTo, formatWhole } from './labels'

export interface ClickUsage {
  sold_on: 'click'
  count: number
  /** YYYY-MM-DD, the Pacific day counted. */
  date: string
  day_zone: string
}

export function ClickUsagePanel({ usage, error, cap, otherSellers, partnerName, nowMs }: {
  usage: ClickUsage | null
  error: string | null
  cap: number | null
  otherSellers: Array<{ id: string; name: string }>
  partnerName: string
  /** The clock "today" is read from; the page's own clock when absent. */
  nowMs?: number
}) {
  if (error || !usage) {
    return <FieldError alert size="xs">{error ?? 'The clicks could not be read.'}</FieldError>
  }
  const count = formatWhole(usage.count)
  const today = zonedParts(nowMs ?? Date.now(), PACIFIC).date === usage.date
  const when = today ? 'today' : `on ${formatCalendarDay(usage.date)}`
  const sentence = cap === null ? `${count} clicks ${when}` : `${count} of ${formatWhole(cap)} clicks ${when}`
  const share = cap === null ? 0 : cap === 0 ? 1 : Math.min(1, usage.count / cap)
  return (
    <div className="space-y-1.5 text-[13px] text-graphite">
      <div className="flex items-center gap-2.5">
        {cap !== null && (
          <div role="meter" aria-label={`Clicks ${when}`} aria-valuenow={Math.min(usage.count, cap)} aria-valuemin={0} aria-valuemax={cap} className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-navy" style={{ width: `${share * 100}%` }} />
          </div>
        )}
        <span>{sentence}</span>
      </div>
      {cap !== null && usage.count >= cap && <p className="text-xs text-amber-800">The cap is reached.</p>}
      {otherSellers.length > 0 && <p className="text-xs text-gray-600">{alsoSellTo(otherSellers, partnerName)}. Those sales are not clicks and are not counted here.</p>}
    </div>
  )
}
