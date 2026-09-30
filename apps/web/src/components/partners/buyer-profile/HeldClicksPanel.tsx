'use client'

/**
 * Held clicks (#1552): the clicks a click buyer's send left held, because
 * whether the buyer has the lead is not known. Until a person releases one, no
 * later click on that prospect sends. Each row carries its two releases:
 *
 *   Mark sent   the person found the lead in the buyer's system; the claim is
 *               marked sent with that lead id and the click is counted
 *   Free        the buyer does not have it; the next click sends it again
 *
 * Every confirmation names the consequence for its own row (L180). Free is the
 * destructive one, because freeing a lead the buyer does have sends it twice,
 * so it looks destructive at rest. The outcome shows on the row (L608).
 * Loading, a failed read and an empty list are three different screens (L10).
 *
 * Mark sent also writes the click's Salesforce updates (#1659). The mark stands
 * whatever Salesforce answers, so an entry whose updates did not all land stays
 * here with each record's result and a retry, which writes the same updates
 * again with the lead id the sale was marked with.
 */
import { useState } from 'react'
import Link from 'next/link'
import { HELD_CLICK_REASON_LABELS, SALE_RECORD_LABELS, type HeldClickReason, type SaleWrite, type SalesforceWritesView } from '@bidspoke/buyer-profile'
import type { HeldClick } from '@/lib/api'
import { Button, Outcome, TextInput, type OutcomeState } from '@/components/ui/form'

const PACIFIC = 'America/Los_Angeles'

function heldSince(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { timeZone: PACIFIC, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

function pacificTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-US', { timeZone: PACIFIC, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

/** The Pacific day the click was held: the day its count lands on. */
function pacificDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { timeZone: PACIFIC, month: 'short', day: 'numeric' })
}

function reasonLabel(reason: string): string {
  return (HELD_CLICK_REASON_LABELS as Record<string, string>)[reason as HeldClickReason] ?? reason
}

function writeLine(w: SaleWrite): string {
  const name = w.id ? `${SALE_RECORD_LABELS[w.record]} ${w.id}` : SALE_RECORD_LABELS[w.record]
  switch (w.outcome) {
    case 'written': return `${name}: updated`
    case 'failed': return `${name}: not updated. ${w.message}`
    case 'not_named': return `${name}: not part of this click`
    case 'not_attempted': return `${name}: not updated. ${w.message}`
  }
}

/**
 * Whether a row's last Salesforce updates leave something for the person to do.
 * A sold entry with NO recorded updates is one whose mark stopped before its
 * updates were audited (a crash between the two), so it is offered them too.
 */
function needsRetry(view: SalesforceWritesView | null): boolean {
  return view !== null && (view.status !== 'recorded' || !view.writes.complete)
}

/** The one reason every record went unattempted for, when there is exactly one. */
function sharedReason(writes: readonly SaleWrite[]): string | null {
  const reasons = new Set<string>()
  for (const w of writes) {
    if (w.outcome !== 'not_attempted') return null
    reasons.add(w.message)
  }
  return reasons.size === 1 ? [...reasons][0] : null
}

/** A sold entry's Salesforce updates that did not all land, each record's result, and the retry. */
function SalesforceUpdates({ sold, view, busy, onRetry }: { sold: boolean; view: SalesforceWritesView | null; busy: boolean; onRetry: () => void }) {
  // Only a sale has Salesforce updates: a click still held, or freed, never shows them, whatever it carries.
  if (!sold || !view || !needsRetry(view)) return null
  let body
  if (view.status === 'unreadable') {
    body = <p className="text-red-700">{view.message}</p>
  } else if (view.status === 'none') {
    body = <p className="text-red-700">No Salesforce update is recorded for this sale.</p>
  } else {
    const writes = view.writes.writes
    const reason = sharedReason(writes)
    // Nothing was attempted, for one reason: say it once (L605).
    body = reason !== null ? (
      <p className="text-red-700">Salesforce was not updated: {reason}</p>
    ) : (
      <>
        <p className="text-red-700">Salesforce was not fully updated.</p>
        <ul className="list-disc pl-4">
          {writes.map((w) => (
            <li key={w.record} className={w.outcome === 'written' ? 'text-graphite' : w.outcome === 'not_named' ? 'text-gray-600' : 'text-red-700'}>{writeLine(w)}</li>
          ))}
        </ul>
      </>
    )
  }
  return (
    // A Salesforce error is often one unbroken JSON string, so it wraps anywhere rather than widening the table.
    <div className="max-w-md space-y-1 [overflow-wrap:anywhere]">
      <div role="alert">{body}</div>
      <Button variant="secondary" className="btn-sm" busy={busy} onClick={onRetry}>Retry the Salesforce updates</Button>
    </div>
  )
}

type Pending ={ id: string; action: 'sent'; leadId: string } | { id: string; action: 'free' } | { id: string; action: 'remove' }

interface Props {
  partnerName: string
  /** null while loading. */
  held: { entries: readonly HeldClick[]; total: number } | null
  error: string | null
  outcomes: Record<string, OutcomeState>
  onMarkSent: (row: HeldClick, generation: number, leadId: string) => void | Promise<void>
  onFree: (row: HeldClick, generation: number) => void | Promise<void>
  onClear: (row: HeldClick) => void | Promise<void>
  onRetrySalesforce: (row: HeldClick) => void | Promise<void>
}

export function HeldClicksPanel({ partnerName, held, error, outcomes, onMarkSent, onFree, onClear, onRetrySalesforce }: Props) {
  const [pending, setPending] = useState<Pending | null>(null)

  if (error) return <p role="alert" className="text-xs text-red-700">The held clicks could not be read: {error}</p>
  if (!held) return <p role="status" className="text-xs text-gray-600">Reading the held clicks…</p>
  if (held.entries.length === 0) return <p className="text-xs text-green-700">No clicks are held for {partnerName}: every click sent has an outcome.</p>

  function remove(row: HeldClick) {
    setPending(null)
    void onClear(row)
  }

  function confirmSent(row: HeldClick, generation: number, leadId: string) {
    const id = leadId.trim()
    if (id === '') return
    setPending(null)
    void onMarkSent(row, generation, id)
  }

  return (
    <div className="space-y-2">
      {held.total > held.entries.length && (
        <p className="text-xs text-gray-600">Showing the oldest {held.entries.length} of {held.total} held clicks.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-600">
              <th scope="col" className="py-1 pr-3 font-medium">Prospect</th>
              <th scope="col" className="py-1 pr-3 font-medium">Held since</th>
              <th scope="col" className="py-1 pr-3 font-medium">Why</th>
              <th scope="col" className="py-1 font-medium">Release</th>
            </tr>
          </thead>
          <tbody>
            {held.entries.map((row) => {
              const outcome = outcomes[row.id] ?? { kind: 'idle' as const }
              const busy = outcome.kind === 'working'
              const mine = pending?.id === row.id ? pending : null
              // The generation the page read, which a release compares and sets on; only a held claim offers one.
              const generation = row.claim.status === 'held' ? row.claim.generation : null
              return (
                <tr key={row.id} className="border-t border-gray-100 align-top text-graphite">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">
                    {row.workflow_id ? (
                      <Link href={`/workflows/${row.workflow_id}/executions/${row.execution_id}`} className="underline">{row.prospect_id}</Link>
                    ) : (
                      row.prospect_id
                    )}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">{heldSince(row.held_at)}</td>
                  <td className="py-1 pr-3">
                    <p>{reasonLabel(row.reason)}</p>
                    <p className="text-gray-600">{row.detail}</p>
                  </td>
                  <td className="py-1">
                    {outcome.kind === 'done' ? (
                      <div className="space-y-1">
                        <Outcome state={outcome} />
                        {row.cleared ? null : <SalesforceUpdates sold={row.claim.status === 'sold'} view={row.salesforce} busy={busy} onRetry={() => void onRetrySalesforce(row)} />}
                      </div>
                    ) :row.claim.status === 'unreadable' ? (
                      <p role="alert" className="text-red-700">{row.claim.message}</p>
                    ) : row.claim.status === 'sending' ? (
                      <p className="text-gray-600">Still sending. It can be released after {pacificTime(row.claim.releasable_at)}.</p>
                    ) : row.claim.status === 'free' || row.claim.status === 'sold' ? (
                      <div className="space-y-1">
                        <p>
                          {row.claim.status === 'free'
                            ? 'No longer held: the claim is free.'
                            : `No longer held: already marked sent${row.claim.partner_lead_id ? ` as ${row.claim.partner_lead_id}` : ''}.`}
                        </p>
                        <SalesforceUpdates sold={row.claim.status === 'sold'} view={row.salesforce} busy={busy} onRetry={() => void onRetrySalesforce(row)} />
                        {row.claim.status === 'sold' && needsRetry(row.salesforce) ? (
                          // This row is the only place the retry lives, so removing it says what is lost and asks first (L9).
                          mine?.action === 'remove' ? (
                            <div className="space-y-1">
                              <p className="text-graphite">
                                Removing this entry also removes its retry. The Salesforce updates that did not land will not be written from Bidspoke, so fix those records in Salesforce by hand. The sale stays marked sent.
                              </p>
                              <div className="flex gap-1.5">
                                <Button variant="danger" className="btn-sm" busy={busy} onClick={() => remove(row)}>Remove it</Button>
                                <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <Button variant="danger" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'remove' })}>Remove from the list</Button>
                          )
                        ) : (
                          <Button variant="secondary" className="btn-sm" busy={busy} onClick={() => remove(row)}>Remove from the list</Button>
                        )}
                        <Outcome state={outcome} />
                      </div>
                    ) : generation === null ? null : mine?.action === 'sent' ? (
                      <div className="space-y-1">
                        <label htmlFor={`held-lead-${row.id}`} className="block text-graphite">Lead id in {partnerName}</label>
                        {/* Enter confirms the mark and never also submits the partner form this sits in (L596). */}
                        <TextInput id={`held-lead-${row.id}`} value={mine.leadId} onChange={(v) => setPending({ ...mine, leadId: v })} onEnter={() => confirmSent(row, generation, mine.leadId)} mono className="w-56" />
                        {mine.leadId.trim() !== '' && (
                          <p className="text-graphite">
                            Records this prospect as sent to {partnerName} as lead {mine.leadId.trim()} and adds it to {partnerName}&apos;s clicks for {pacificDay(row.held_at)} (Pacific). A later click on it will not send.
                          </p>
                        )}
                        <div className="flex gap-1.5">
                          <Button variant="primary" className="btn-sm" busy={busy} disabled={mine.leadId.trim() === ''} onClick={() => confirmSent(row, generation, mine.leadId)}>Mark it sent</Button>
                          <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : mine?.action === 'free' ? (
                      <div className="space-y-1">
                        <p className="text-graphite">
                          Use this only if {partnerName} does not have this lead. The claim is freed, the next click on this prospect sends it to {partnerName} again, and nothing is counted.
                        </p>
                        <div className="flex gap-1.5">
                          <Button variant="danger" className="btn-sm" busy={busy} onClick={() => { setPending(null); void onFree(row, generation) }}>Free it</Button>
                          <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex gap-1.5 whitespace-nowrap">
                          <Button variant="secondary" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'sent', leadId: row.partner_lead_id ?? '' })}>Mark sent</Button>
                          <Button variant="danger" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'free' })}>Free</Button>
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
