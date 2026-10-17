'use client'

/**
 * The unresolved list (#1412, L269, L180): sales nobody could classify, each
 * with its own settle controls. A confirmation names the consequence of the
 * row it is on, derived from that row, and the outcome of the settle shows on
 * the row, in the three distinct states.
 */
import { useState } from 'react'
import { Button, Outcome, type OutcomeState } from '@/components/ui/form'
import { formatCents, formatWhole } from './labels'
import { DEFAULT_DISPLAY_TIME_ZONE, type DisplayTimeZone } from '@bidspoke/buyer-profile'
import { formatInZone } from '@/lib/dates'

export interface UnresolvedSale {
  id: string
  lead_key: string
  kind: string
  payout_cents: number
  reserved_at: string
  http_status: number | null
  result_code: string | null
  partner_name: string
}

export type SettleOutcome = 'accepted' | 'released'

/** What the buyer answered, as one sentence on the card. */
function answerSentence(row: UnresolvedSale): string {
  if (row.http_status === null) return `No answer arrived from ${row.partner_name}.`
  if (row.http_status >= 200 && row.http_status < 300) return `${row.partner_name} answered HTTP ${row.http_status}, no rule matched.`
  return `${row.partner_name} answered HTTP ${row.http_status}.`
}

/** When the slot was reserved, in the profile's display zone and naming it, as the held clicks say when a click was held (#2253). */
function reservedAt(iso: string, zone: DisplayTimeZone): string {
  return formatInZone(iso, zone, 'day-time')
}

export function UnresolvedSalesList({ rows, total, onSettle, outcomes, onMore, loadingMore = false, zone = DEFAULT_DISPLAY_TIME_ZONE }: {
  rows: readonly UnresolvedSale[]
  total: number
  onSettle: (id: string, outcome: SettleOutcome) => void | Promise<void>
  outcomes: Record<string, OutcomeState>
  /** Asks for the next page of this buyer's queue; offered only while `total` is above the rows shown (#1457). */
  onMore?: () => void
  loadingMore?: boolean
  /** The profile's display zone, the one its hours and held clicks are shown in. */
  zone?: DisplayTimeZone
}) {
  const [confirming, setConfirming] = useState<{ id: string; outcome: SettleOutcome } | null>(null)

  if (rows.length === 0) return <p className="text-xs text-green-700">Nothing waiting on a person: every sale has an outcome.</p>

  // The queue's own total, so the sentence counts what is waiting, not only the rows read so far (#1457).
  const lead = total === 1
    ? '1 sale has no outcome. Its slot stays reserved until a person settles it.'
    : `${formatWhole(total)} sales have no outcome. Each slot stays reserved until a person settles it.`

  return (
    <div className="space-y-2 text-xs">
      <p className="text-[13px] text-graphite">{lead}</p>
      {total > rows.length && (
        <div className="flex items-center gap-3">
          <p className="text-gray-600">Showing {rows.length} of {total} unresolved sales.</p>
          {onMore && (
            <Button variant="secondary" className="btn-sm" busy={loadingMore} disabled={loadingMore} onClick={onMore}>
              Show {total - rows.length} more
            </Button>
          )}
        </div>
      )}
      {/* A card per sale, like the held clicks: each button followed by what it does (#2325, PM-22). */}
      <ul aria-label="Unresolved sales" className="space-y-2">
        {rows.map((row) => {
          const pending = confirming?.id === row.id ? confirming : null
          const outcome = outcomes[row.id] ?? { kind: 'idle' as const }
          const busy = outcome.kind === 'working'
          const pay = formatCents(row.payout_cents)
          return (
            <li key={row.id} aria-label={row.lead_key} className="space-y-1.5 rounded-lg border border-line bg-white p-3 text-graphite">
              <p className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="font-mono">{row.lead_key}</span>
                <span className="text-gray-600">{reservedAt(row.reserved_at, zone)}</span>
                <span className="tabular-nums">{pay}</span>
              </p>
              <p>{answerSentence(row)}</p>
              {outcome.kind === 'done' ? (
                <Outcome state={outcome} />
              ) : pending ? (
                <div className="space-y-1">
                  <p>
                    {pending.outcome === 'accepted'
                      ? `Counts as sold to ${row.partner_name} for ${pay} today.`
                      : 'Frees one slot and counts nothing.'}
                  </p>
                  <div className="flex gap-1.5">
                    <Button variant={pending.outcome === 'accepted' ? 'primary' : 'danger'} className="btn-sm" busy={busy} onClick={() => { setConfirming(null); void onSettle(row.id, pending.outcome) }}>
                      Confirm
                    </Button>
                    <Button variant="secondary" className="btn-sm" onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5">
                    <Button variant="secondary" className="btn-sm" disabled={busy} onClick={() => setConfirming({ id: row.id, outcome: 'accepted' })}>Count as sold</Button>
                    <span className="text-gray-600">{row.partner_name} has it. Counts as sold for {pay} today.</span>
                    <Button variant="danger" className="btn-sm" disabled={busy} onClick={() => setConfirming({ id: row.id, outcome: 'released' })}>Free the slot</Button>
                    <span className="text-gray-600">{row.partner_name} does not have it. Frees one slot and counts nothing.</span>
                  </div>
                  <Outcome state={outcome} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
