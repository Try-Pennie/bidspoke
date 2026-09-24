'use client'

/**
 * The usage panel (#1412): the counted total against each cap with its
 * breakdown, from the same counted() the ledger refuses from (L16); a positive
 * statement on a healthy day (L610); the scope with the other sellers named
 * beside their count (L582, L287); and an unreadable ledger as its own state
 * with no numbers (L633).
 */
import type { CapsValue } from './CapsGrid'
import { formatCents, formatWhole } from './labels'

export interface BuyerUsage {
  sold_on: 'offer'
  et_day: string
  hour_bucket: number
  hour: { leads: number; spend_cents: number }
  day: { leads: number; spend_cents: number; by_status: Record<string, number> }
  counted_populations: string[]
  outside_wins_today: number | null
  unmeasured: string[]
}

const NEAR = 0.8

function line(count: string, cap: string | null, period: string): string {
  return cap === null ? `${count} ${period}, no cap` : `${count} of ${cap} ${period}`
}

export function BuyerUsagePanel({ usage, error, caps, otherSellers, partnerName }: {
  usage: BuyerUsage | null
  error: string | null
  caps: CapsValue
  otherSellers: Array<{ id: string; name: string }>
  partnerName: string
}) {
  if (error || !usage) {
    return <p role="alert" className="text-xs text-red-700">{error ?? 'The usage counts could not be read.'}</p>
  }
  const s = usage.day.by_status
  const inFlight = s.reserved ?? 0
  const near =
    (caps.daily_lead_cap !== null && usage.day.leads >= caps.daily_lead_cap * NEAR) ||
    (caps.hourly_lead_cap !== null && usage.hour.leads >= caps.hourly_lead_cap * NEAR) ||
    (caps.daily_spend_cap_cents !== null && usage.day.spend_cents >= caps.daily_spend_cap_cents * NEAR) ||
    (caps.hourly_spend_cap_cents !== null && usage.hour.spend_cents >= caps.hourly_spend_cap_cents * NEAR)
  const sellers = otherSellers.map((w) => w.name).join(' and ')
  const outsideSentence = otherSellers.length === 0
    ? null
    : usage.unmeasured.includes('outside_wins_today') || usage.outside_wins_today === null
      ? `${sellers} also sells to ${partnerName}. Today's count of those sales could not be read.`
      : `${sellers} also sells to ${partnerName}. Those ${usage.outside_wins_today} sales today are not counted here.`

  return (
    <div className="space-y-2 text-sm text-graphite">
      <p className="text-xs text-gray-500">Counted for {usage.et_day}, as the buyer ledger holds it right now.</p>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <li>{line(formatWhole(usage.day.leads), caps.daily_lead_cap === null ? null : formatWhole(caps.daily_lead_cap), 'leads today')}</li>
        <li>{line(formatCents(usage.day.spend_cents), caps.daily_spend_cap_cents === null ? null : formatCents(caps.daily_spend_cap_cents), 'today')}</li>
        <li>{line(formatWhole(usage.hour.leads), caps.hourly_lead_cap === null ? null : formatWhole(caps.hourly_lead_cap), 'leads this hour')}</li>
        <li>{line(formatCents(usage.hour.spend_cents), caps.hourly_spend_cap_cents === null ? null : formatCents(caps.hourly_spend_cap_cents), 'this hour')}</li>
      </ul>
      <p className="text-xs text-gray-600">
        Counted today: {formatWhole(s.accepted ?? 0)} accepted, {formatWhole(inFlight)} in flight, {formatWhole(s.unresolved ?? 0)} unresolved. Declined and released sales are not counted.
      </p>
      {near ? (
        <p className="text-xs text-amber-800">A cap is within reach today.</p>
      ) : (
        <p className="text-xs text-green-700">Room under every cap today.</p>
      )}
      {outsideSentence && <p className="text-xs text-gray-600">{outsideSentence}</p>}
    </div>
  )
}
