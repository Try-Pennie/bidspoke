'use client'

/**
 * A click sold buyer's usage (#1543): the distinct clicks from its click counter
 * for the date counted, against the profile's clicks per day, the same count
 * buyer_click_check stops offering at (L16). A positive statement on a healthy
 * day (L610) and an unreadable counter as its own state with no number (L633).
 *
 * Every fact once on the page (#1557, L605): that a day runs midnight to
 * midnight Pacific, and that a buyer with no cap is not offered, are both said
 * by the caps note above; this panel shows the date and the count against the cap.
 */
import { FieldError } from '@/components/ui/form'
import { alsoSellTo, CAP_NEAR_SHARE, formatWhole } from './labels'

export interface ClickUsage {
  sold_on: 'click'
  count: number
  /** YYYY-MM-DD, the Pacific day counted. */
  date: string
  day_zone: string
}

export function ClickUsagePanel({ usage, error, cap, otherSellers, partnerName }: {
  usage: ClickUsage | null
  error: string | null
  cap: number | null
  otherSellers: Array<{ id: string; name: string }>
  partnerName: string
}) {
  if (error || !usage) {
    return <FieldError alert size="xs">{error ?? 'The clicks could not be read.'}</FieldError>
  }
  const count = formatWhole(usage.count)
  const state = cap === null ? null : usage.count >= cap ? 'reached' : usage.count >= cap * CAP_NEAR_SHARE ? 'near' : 'room'
  return (
    <div className="space-y-2 text-sm text-graphite">
      <p>{cap === null ? `${count} clicks on ${usage.date}` : `${count} of ${formatWhole(cap)} clicks on ${usage.date}`}</p>
      {state === 'reached' ? (
        <p className="text-xs text-amber-800">The cap is reached.</p>
      ) : state === 'near' ? (
        <p className="text-xs text-amber-800">The cap is within reach.</p>
      ) : state === 'room' ? (
        <p className="text-xs text-green-700">Room under the cap.</p>
      ) : null}
      {otherSellers.length > 0 && <p className="text-xs text-gray-600">{alsoSellTo(otherSellers, partnerName)}. Those sales are not clicks and are not counted here.</p>}
    </div>
  )
}
