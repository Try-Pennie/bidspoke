'use client'

/**
 * A click sold buyer's usage (#1543): today's distinct clicks from its click
 * counter against the profile's clicks per day, the same count buyer_click_check
 * stops offering at (L16), on the Pacific day the counter resets on. A positive
 * statement on a healthy day (L610) and an unreadable counter as its own state
 * with no number (L633).
 */
import { formatWhole } from './labels'

export interface ClickUsage {
  sold_on: 'click'
  count: number
  /** YYYY-MM-DD, the Pacific day counted. */
  date: string
  day_zone: string
}

const NEAR = 0.8

export function ClickUsagePanel({ usage, error, cap, otherSellers, partnerName }: {
  usage: ClickUsage | null
  error: string | null
  cap: number | null
  otherSellers: Array<{ id: string; name: string }>
  partnerName: string
}) {
  if (error || !usage) {
    return <p role="alert" className="text-xs text-red-700">{error ?? 'The clicks today could not be read.'}</p>
  }
  const count = formatWhole(usage.count)
  const state = cap === null ? 'uncapped' : usage.count >= cap ? 'reached' : usage.count >= cap * NEAR ? 'near' : 'room'
  const sellers = otherSellers.map((w) => w.name).join(' and ')
  return (
    <div className="space-y-2 text-sm text-graphite">
      <p className="text-xs text-gray-500">Counted for {usage.date}, a day that runs midnight to midnight Pacific time.</p>
      <p>{cap === null ? `${count} clicks today` : `${count} of ${formatWhole(cap)} clicks today`}</p>
      {state === 'reached' ? (
        <p className="text-xs text-amber-800">The cap is reached. This buyer is not offered again until midnight Pacific.</p>
      ) : state === 'near' ? (
        <p className="text-xs text-amber-800">The cap is within reach today.</p>
      ) : state === 'room' ? (
        <p className="text-xs text-green-700">Room under the cap today.</p>
      ) : (
        <p className="text-xs text-amber-800">No clicks per day is set, so this buyer is not offered.</p>
      )}
      {otherSellers.length > 0 && <p className="text-xs text-gray-600">{sellers} also sells to {partnerName}. Those sales are not clicks and are not counted here.</p>}
    </div>
  )
}
