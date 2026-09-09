'use client'

/**
 * What this lead earned: what a buyer paid us, what we quoted the source that
 * sent it, and the difference (#1160).
 *
 * Both halves were already recorded and nothing put them together.
 * `winning_bid_cents` is money IN and `quoted_rate_cents` is money OUT, and two
 * dollar figures side by side read as comparable amounts of the same thing
 * unless the surface says otherwise, so each one is labelled by its direction
 * rather than by its column name.
 */

export interface LeadEconomics {
  /** What we quoted the source that sent the lead, in cents. Money out. */
  quoted_rate_cents: number | null
  /** What the winning buyer paid us for the lead, in cents. Money in. */
  winning_bid_cents: number | null
  /** bid less quote, or null when either side is unknown. */
  margin_cents: number | null
  winning_partner_slug: string | null
}

/**
 * The margin between what a buyer paid and what we quoted.
 *
 * Null whenever either side is unknown. An absent quote is NOT zero: treating it
 * as zero would report the whole bid as profit, which is the most flattering
 * possible reading of missing data.
 */
export function marginCents(bid: number | null, quote: number | null): number | null {
  if (typeof bid !== 'number' || typeof quote !== 'number') return null
  return bid - quote
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

/** A figure with the direction it runs stated beside it, or an honest absence. */
function Figure({ label, cents, tone }: { label: string; cents: number | null; tone?: 'gain' | 'loss' }) {
  return (
    <div>
      <p className="text-xs text-gray-600">{label}</p>
      {cents === null ? (
        // Not a zero: a figure nobody recorded and a figure that was zero are
        // different facts, and only one of them means the lead earned nothing.
        <p className="mt-0.5 font-mono text-sm text-gray-600">Not recorded</p>
      ) : (
        <p
          className={`mt-0.5 font-mono text-sm ${
            tone === 'loss' ? 'text-red-700' : tone === 'gain' ? 'text-green-700' : 'text-graphite'
          }`}
        >
          {money(cents)}
        </p>
      )}
    </div>
  )
}

export function LeadMargin({ economics }: { economics: LeadEconomics | null }) {
  // No sighting row at all. Executions are kept 7 days and lead_sightings about
  // two, so an execution in that gap has nothing to show, and showing zeroes
  // would assert that the lead earned nothing.
  if (!economics) return null

  const { quoted_rate_cents, winning_bid_cents, margin_cents, winning_partner_slug } = economics

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Lead economics</h2>
      <div className="grid grid-cols-3 gap-4 rounded-xl border border-gray-200 bg-white p-4">
        <Figure
          label={winning_partner_slug ? `${winning_partner_slug} paid us` : 'A buyer paid us'}
          cents={winning_bid_cents}
        />
        <Figure label="We quoted the source" cents={quoted_rate_cents} />
        <Figure
          label="Margin on this lead"
          cents={margin_cents}
          tone={margin_cents === null ? undefined : margin_cents < 0 ? 'loss' : 'gain'}
        />
      </div>
    </div>
  )
}
