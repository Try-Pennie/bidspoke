'use client'

/**
 * The unresolved list (#1412, L269, L180): sales nobody could classify, each
 * with its own settle controls. A confirmation names the consequence of the
 * row it is on, derived from that row, and the outcome of the settle shows on
 * the row, in the three distinct states.
 */
import { useState } from 'react'
import { Button, Outcome, type OutcomeState } from '@/components/ui/form'
import { formatCents } from './labels'
import { formatEtDayTime } from '@/lib/dates'

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

function answerOf(row: UnresolvedSale): string {
  if (row.http_status === null) return 'No answer arrived'
  if (row.http_status >= 200 && row.http_status < 300) return `HTTP ${row.http_status}, no rule matched`
  return `HTTP ${row.http_status}`
}

function reservedAt(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : formatEtDayTime(iso)
}

export function UnresolvedSalesList({ rows, total, onSettle, outcomes, onMore, loadingMore = false }: {
  rows: readonly UnresolvedSale[]
  total: number
  onSettle: (id: string, outcome: SettleOutcome) => void | Promise<void>
  outcomes: Record<string, OutcomeState>
  /** Asks for the next page of this buyer's queue; offered only while `total` is above the rows shown (#1457). */
  onMore?: () => void
  loadingMore?: boolean
}) {
  const [confirming, setConfirming] = useState<{ id: string; outcome: SettleOutcome } | null>(null)

  if (rows.length === 0) return <p className="text-xs text-green-700">Nothing waiting on a person: every sale has an outcome.</p>

  return (
    <div className="space-y-2">
      {total > rows.length && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-600">Showing {rows.length} of {total} unresolved sales.</p>
          {onMore && (
            <Button variant="secondary" className="btn-sm" busy={loadingMore} disabled={loadingMore} onClick={onMore}>
              Show {total - rows.length} more
            </Button>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-600">
            <th scope="col" className="py-1 pr-3 font-medium">Lead</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Payout</th>
            <th scope="col" className="py-1 pr-3 font-medium">Reserved</th>
            <th scope="col" className="py-1 pr-3 font-medium">Buyer answered</th>
            <th scope="col" className="py-1 font-medium">Settle</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pending = confirming?.id === row.id ? confirming : null
            const outcome = outcomes[row.id] ?? { kind: 'idle' as const }
            const busy = outcome.kind === 'working'
            return (
              <tr key={row.id} className="border-t border-gray-100 align-middle text-graphite">
                <td className="py-1 pr-3 font-mono whitespace-nowrap">{row.lead_key}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{formatCents(row.payout_cents)}</td>
                <td className="py-1 pr-3 whitespace-nowrap">{reservedAt(row.reserved_at)}</td>
                <td className="py-1 pr-3">{answerOf(row)}</td>
                <td className="py-1">
                  {outcome.kind === 'done' ? (
                    <Outcome state={outcome} />
                  ) : pending ? (
                    <div className="space-y-1">
                      <p className="text-graphite">
                        {pending.outcome === 'accepted'
                          ? `Counts as sold to ${row.partner_name} for ${formatCents(row.payout_cents)} today.`
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
                    <div className="space-y-1">
                      <div className="flex gap-1.5 whitespace-nowrap">
                        <Button variant="secondary" className="btn-sm" disabled={busy} onClick={() => setConfirming({ id: row.id, outcome: 'accepted' })}>Count as sold</Button>
                        <Button variant="secondary" className="btn-sm" disabled={busy} onClick={() => setConfirming({ id: row.id, outcome: 'released' })}>Free the slot</Button>
                      </div>
                      <Outcome state={outcome} />
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
