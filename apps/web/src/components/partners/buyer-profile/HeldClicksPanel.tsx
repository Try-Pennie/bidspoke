'use client'

/**
 * Held clicks (#1552): the clicks a click buyer's send left held, because
 * whether the buyer has the lead is not known. Until a person releases one, no
 * later click on that prospect sends. Each is a card, with its two releases and
 * what each does said beside it (the settled design, #2114):
 *
 *   Mark sent   the buyer has it; an optional lead id box opens in the card
 *               (PM-7), and the click is counted and Completed in Salesforce
 *               with or without an id
 *   Free        the buyer does not have it; the next click sends it again
 *
 * Every confirmation names the consequence for its own card (L180). Free is the
 * destructive one, because freeing a lead the buyer does have sends it twice,
 * so it looks destructive at rest. The outcome shows on the card (L608).
 * Loading, a failed read and an empty list are three different screens (L10).
 *
 * Sales stay listed too (#2139): one whose Salesforce updates did not all land,
 * with each record's result in Salesforce's own words and Retry Salesforce
 * (PM-8), driven by the entry's `salesforce_standing`; and one marked sent with
 * no lead id, because this list is the one place its id can be added (L1008).
 * The lead sentence counts only the clicks still held. Removing a sale whose
 * removal loses something (its retry, or the place to add its id) asks first
 * in the app Dialog, naming what goes.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { BUYER_LEAD_ID_MAX, HELD_CLICK_REASON_LABELS, SALE_RECORD_LABELS, buyerLeadIdOf, salesforceStandingOf, type DisplayTimeZone, type HeldClickReason, type SaleWrite, type SalesforceStanding } from '@bidspoke/buyer-profile'
import type { HeldClick } from '@/lib/api'
import { Dialog } from '@/components/Dialog'
import { Button, FieldError, Outcome, TextInput, describedBy, type OutcomeState } from '@/components/ui/form'
import { formatInZone } from '@/lib/dates'

const PACIFIC = 'America/Los_Angeles'

// When a click was held and when it can be released are shown in the profile's
// display zone, as its hours are, each naming the zone (#2253).
const heldSince = (iso: string, zone: DisplayTimeZone) => formatInZone(iso, zone, 'day-time')

const releaseTime = (iso: string, zone: DisplayTimeZone) => formatInZone(iso, zone, 'clock')

/** The Pacific day the click was held: the day its count lands on. */
const pacificDay = (iso: string) => formatInZone(iso, PACIFIC, 'day')

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

/** The one reason every record went unattempted for, when there is exactly one. */
function sharedReason(writes: readonly SaleWrite[]): string | null {
  const reasons = new Set<string>()
  for (const w of writes) {
    if (w.outcome !== 'not_attempted') return null
    reasons.add(w.message)
  }
  return reasons.size === 1 ? [...reasons][0] : null
}

/** Said under a lead id box whose text buyerLeadIdOf refuses (the Worker refuses the same text, L370). */
const LEAD_ID_INVALID = `A lead id has no spaces and is at most ${BUYER_LEAD_ID_MAX} characters.`

type SoldClaim = Extract<HeldClick['claim'], { status: 'sold' }>

/**
 * Where a sale stands in Salesforce: the Worker's own reading when it sent one
 * (#2139), or, from a Worker older than that, the same rule over its writes
 * (salesforceStandingOf, L342). Null when no Salesforce view came with it.
 */
function standingOf(row: HeldClick, claim: SoldClaim): SalesforceStanding | null {
  if (row.salesforce_standing) return row.salesforce_standing
  return row.salesforce ? salesforceStandingOf(row.salesforce, claim.partner_lead_id) : null
}

/** What a sale's Salesforce state leaves to do, in its own words for each state; Retry Salesforce sits under it. */
function SalesforceProblem({ row, claim, standing }: { row: HeldClick; claim: SoldClaim; standing: SalesforceStanding }) {
  const view = row.salesforce
  let body
  if (standing === 'unreadable') {
    body = <FieldError>{view?.status === 'unreadable' ? view.message : 'Where this sale stands in Salesforce could not be read.'}</FieldError>
  } else if (standing === 'not_recorded') {
    body = <FieldError>No Salesforce update is recorded for this sale.</FieldError>
  } else if (standing === 'lead_id_not_written') {
    const carried = view?.status === 'recorded' ? view.writes.buyer_lead_id ?? null : null
    body = (
      <FieldError>
        Salesforce does not have {claim.partner_lead_id ? `lead id ${claim.partner_lead_id}` : "this sale's lead id"} yet: its last updates carried {carried ? `lead id ${carried}` : 'no lead id'}.
      </FieldError>
    )
  } else {
    const writes = view?.status === 'recorded' ? view.writes.writes : []
    const reason = sharedReason(writes)
    // Nothing was attempted, for one reason: say it once (L605).
    body = reason !== null ? (
      <FieldError>Salesforce was not updated: {reason}</FieldError>
    ) : (
      <>
        <FieldError>Salesforce was not fully updated.</FieldError>
        <ul className="list-disc pl-4">
          {writes.map((w) => (
            w.outcome === 'written' || w.outcome === 'not_named'
              ? <li key={w.record} className={w.outcome === 'written' ? 'text-graphite' : 'text-gray-600'}>{writeLine(w)}</li>
              : <FieldError as="li" key={w.record}>{writeLine(w)}</FieldError>
          ))}
        </ul>
      </>
    )
  }
  return (
    // A Salesforce error is often one unbroken JSON string, so it wraps anywhere rather than widening the card.
    <div role="alert" className="max-w-xl space-y-1 [overflow-wrap:anywhere]">{body}</div>
  )
}

/**
 * What removing a sale from the list loses, one sentence per loss, derived from
 * the sale's state (L180); empty when nothing is lost and no question is asked.
 */
function removalLosses(partnerName: string, claim: SoldClaim, standing: SalesforceStanding | null): string[] {
  const losses: string[] = []
  if (standing !== null && standing !== 'written') losses.push('Its Salesforce retry goes with it, so whatever Salesforce is missing for this sale must be fixed there by hand.')
  if (!claim.partner_lead_id) losses.push(`This list is the only place ${partnerName}'s lead id can be added to this sale; after this it can be added only in Salesforce.`)
  return losses
}

type Pending =
  | { id: string; action: 'sent'; leadId: string }
  | { id: string; action: 'free' }
  | { id: string; action: 'lead'; leadId: string }
  | { id: string; action: 'remove'; losses: string[]; prospect: string }

interface Props {
  partnerName: string
  /** The profile's display zone, the one its hours are shown in. */
  zone: DisplayTimeZone
  /** null while loading. */
  held: { entries: readonly HeldClick[]; total: number } | null
  error: string | null
  outcomes: Record<string, OutcomeState>
  /** `leadId` is null when the person has none: the sale is still counted and Completed (PM-7). */
  onMarkSent: (row: HeldClick, generation: number, leadId: string | null) => void | Promise<void>
  onFree: (row: HeldClick, generation: number) => void | Promise<void>
  onClear: (row: HeldClick) => void | Promise<void>
  onRetrySalesforce: (row: HeldClick) => void | Promise<void>
  /** Add or correct a marked sent sale's lead id, at the generation the page read (#2139). */
  onSetLeadId: (row: HeldClick, generation: number, leadId: string) => void | Promise<void>
}

/** The clicks still held, which is what no later click waits on: a sale on the list is not one. */
function leadSentence(partnerName: string, entries: readonly HeldClick[], truncated: boolean): string | null {
  const n = entries.filter((e) => e.claim.status === 'held' || e.claim.status === 'sending').length
  if (n === 0) return truncated ? null : `No clicks are held for ${partnerName}.`
  const count = `${truncated ? 'At least ' : ''}${n} click${n === 1 ? '' : 's'} held.`
  return n === 1
    ? `${count} No later click on this prospect is sent until it is released.`
    : `${count} No later click on these prospects is sent until each is released.`
}

export function HeldClicksPanel({ partnerName, zone, held, error, outcomes, onMarkSent, onFree, onClear, onRetrySalesforce, onSetLeadId }: Props) {
  const [pending, setPending] = useState<Pending | null>(null)

  if (error) return <FieldError alert size="xs">The held clicks could not be read: {error}</FieldError>
  if (!held) return <p role="status" className="text-xs text-gray-600">Reading the held clicks…</p>
  if (held.entries.length === 0) return <p className="text-xs text-green-700">No clicks are held for {partnerName}: every click sent has an outcome.</p>

  const truncated = held.total > held.entries.length
  const lead = leadSentence(partnerName, held.entries, truncated)
  const removing = pending?.action === 'remove' ? pending : null
  const removingRow = removing ? held.entries.find((e) => e.id === removing.id) ?? null : null

  function remove(row: HeldClick) {
    setPending(null)
    void onClear(row)
  }

  function confirmSent(row: HeldClick, generation: number, text: string) {
    const parsed = buyerLeadIdOf(text)
    if (!parsed.ok) return
    setPending(null)
    void onMarkSent(row, generation, parsed.id)
  }

  function confirmLeadId(row: HeldClick, claim: SoldClaim, text: string) {
    const parsed = buyerLeadIdOf(text)
    if (!parsed.ok || parsed.id === null || parsed.id === claim.partner_lead_id) return
    setPending(null)
    void onSetLeadId(row, claim.generation, parsed.id)
  }

  /** The held card's Mark sent box: optional lead id, the consequence derived from what is typed. */
  function markSentBox(row: HeldClick, generation: number, mine: Extract<Pending, { action: 'sent' }>, busy: boolean) {
    const inputId = `held-lead-${row.id}`
    const parsed = buyerLeadIdOf(mine.leadId)
    const day = pacificDay(row.held_at)
    return (
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-graphite">{partnerName}&apos;s lead id, if you have it</label>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Enter confirms the mark and never also submits the partner form this sits in (L596). */}
          <TextInput id={inputId} value={mine.leadId} onChange={(v) => setPending({ ...mine, leadId: v })} onEnter={() => confirmSent(row, generation, mine.leadId)} placeholder="Optional" mono className="w-60" describedBy={describedBy(inputId, parsed.ok, !parsed.ok)} />
          <Button variant="primary" className="btn-sm" busy={busy} disabled={!parsed.ok} onClick={() => confirmSent(row, generation, mine.leadId)}>Mark it sent</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
        </div>
        {parsed.ok ? (
          <p id={`${inputId}-hint`} className="text-gray-600">
            The click is counted in {partnerName}&apos;s clicks for {day} (Pacific), and Salesforce marks the sale Completed with {parsed.id === null ? 'no lead id' : `lead id ${parsed.id}`}. A later click on this prospect will not send.
          </p>
        ) : (
          <FieldError id={`${inputId}-error`} alert>{LEAD_ID_INVALID}</FieldError>
        )}
      </div>
    )
  }

  /** A sale's Add or Correct lead id box (#2139, L1008): an id is required, and the same id is not a change. */
  function leadIdBox(row: HeldClick, claim: SoldClaim, mine: Extract<Pending, { action: 'lead' }>, busy: boolean) {
    const inputId = `held-amend-${row.id}`
    const parsed = buyerLeadIdOf(mine.leadId)
    const current = claim.partner_lead_id
    const ready = parsed.ok && parsed.id !== null && parsed.id !== current
    let hint: string | null = null
    if (parsed.ok) {
      if (parsed.id === null) hint = `Enter the lead id ${partnerName} shows for this prospect.`
      else if (parsed.id === current) hint = `This sale already has lead id ${current}.`
      else hint = current
        ? `Replaces lead id ${current} with ${parsed.id} for this sale and writes it to Salesforce.`
        : `Records lead id ${parsed.id} for this sale and writes it to Salesforce.`
    }
    return (
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-graphite">{partnerName}&apos;s lead id</label>
        <div className="flex flex-wrap items-center gap-1.5">
          <TextInput id={inputId} value={mine.leadId} onChange={(v) => setPending({ ...mine, leadId: v })} onEnter={() => confirmLeadId(row, claim, mine.leadId)} mono className="w-60" describedBy={describedBy(inputId, hint !== null, hint === null)} />
          <Button variant="primary" className="btn-sm" busy={busy} disabled={!ready} onClick={() => confirmLeadId(row, claim, mine.leadId)}>{current ? 'Correct the lead id' : 'Add the lead id'}</Button>
          <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
        </div>
        {hint !== null
          ? <p id={`${inputId}-hint`} className="text-gray-600">{hint}</p>
          : <FieldError id={`${inputId}-error`} alert>{LEAD_ID_INVALID}</FieldError>}
      </div>
    )
  }

  /** A sale on the list: marked sent with its lead id or none, its Salesforce state, and what is left to do. */
  function soldBody(row: HeldClick, claim: SoldClaim, outcome: OutcomeState, busy: boolean) {
    const standing = standingOf(row, claim)
    const mine = pending?.id === row.id && pending.action === 'lead' ? pending : null
    const losses = removalLosses(partnerName, claim, standing)
    const retry = standing !== null && standing !== 'written'
    return (
      <div className="space-y-1.5">
        <p>
          <span className="font-medium text-graphite">Marked sent</span>{' '}
          <span className="text-gray-600">
            {/* Counted unless this page was told the count did not land (#2325, the design's "Counted."). */}
            {row.counted === false ? '' : 'Counted. '}{partnerName}&apos;s lead id: {claim.partner_lead_id ?? 'none given'}.{standing === 'written' ? ' Completed in Salesforce.' : ''}
          </span>
        </p>
        <Outcome state={outcome} />
        {mine ? leadIdBox(row, claim, mine, busy) : (
          <div>
            <Button variant="quiet" className="-ml-2" disabled={busy} onClick={() => setPending({ id: row.id, action: 'lead', leadId: claim.partner_lead_id ?? '' })}>
              {claim.partner_lead_id ? null : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              {claim.partner_lead_id ? 'Correct' : 'Add'} {partnerName}&apos;s lead id
            </Button>
          </div>
        )}
        {retry && <SalesforceProblem row={row} claim={claim} standing={standing} />}
        <div className="flex flex-wrap gap-1.5">
          {retry && <Button variant="secondary" className="btn-sm" busy={busy} onClick={() => void onRetrySalesforce(row)}>Retry Salesforce</Button>}
          {losses.length > 0 ? (
            // Removing loses something only this card holds, so it looks destructive and asks first (L9).
            <Button variant="danger" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'remove', losses, prospect: row.prospect_id })}>Remove from the list</Button>
          ) : (
            <Button variant="secondary" className="btn-sm" busy={busy} onClick={() => remove(row)}>Remove from the list</Button>
          )}
        </div>
      </div>
    )
  }

  function actions(row: HeldClick) {
    const outcome = outcomes[row.id] ?? { kind: 'idle' as const }
    const busy = outcome.kind === 'working'
    const claim = row.claim
    // An entry gone from the list keeps only its outcome: nothing on it can be acted on any more.
    if (row.cleared) return <Outcome state={outcome} />
    if (claim.status === 'sold') return soldBody(row, claim, outcome, busy)
    if (outcome.kind === 'done') return <Outcome state={outcome} />
    if (claim.status === 'unreadable') return <FieldError alert>{claim.message}</FieldError>
    if (claim.status === 'sending') return <p className="text-gray-600">Still sending. It can be released after {releaseTime(claim.releasable_at, zone)}.</p>
    if (claim.status === 'free') {
      return (
        <div className="space-y-1.5">
          <p>No longer held: the claim is free.</p>
          <Button variant="secondary" className="btn-sm" busy={busy} onClick={() => remove(row)}>Remove from the list</Button>
          <Outcome state={outcome} />
        </div>
      )
    }
    // Held: the generation the page read, which a release compares and sets on.
    const generation = claim.generation
    const mine = pending?.id === row.id ? pending : null
    if (mine?.action === 'sent') return markSentBox(row, generation, mine, busy)
    if (mine?.action === 'free') {
      return (
        <div className="space-y-1">
          <p className="text-graphite">
            Use this only if {partnerName} does not have this lead. The claim is freed, the next click on this prospect sends it to {partnerName} again, and nothing is counted.
          </p>
          <div className="flex gap-1.5">
            <Button variant="danger" className="btn-sm" busy={busy} onClick={() => { setPending(null); void onFree(row, generation) }}>Free it</Button>
            <Button variant="secondary" className="btn-sm" onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </div>
      )
    }
    return (
      <div className="space-y-1.5">
        {/* Each button with what it does beside it (the settled design's cards). */}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5">
          <Button variant="secondary" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'sent', leadId: row.partner_lead_id ?? '' })}>Mark sent</Button>
          <span className="text-gray-600">The buyer has it. Counted, and Completed in Salesforce.</span>
          <Button variant="danger" className="btn-sm" disabled={busy} onClick={() => setPending({ id: row.id, action: 'free' })}>Free</Button>
          <span className="text-gray-600">The buyer does not have it. The next click sends again.</span>
        </div>
        <Outcome state={outcome} />
      </div>
    )
  }

  return (
    <div className="space-y-2 text-xs">
      {lead && <p className="text-sm text-graphite">{lead}</p>}
      {truncated && <p className="text-gray-600">Showing the oldest {held.entries.length} of {held.total}.</p>}
      <ul aria-label={`Held clicks for ${partnerName}`} className="space-y-2">
        {held.entries.map((row) => (
          <li key={row.id} className="space-y-1.5 rounded-lg border border-gray-200 bg-white p-3 text-graphite">
            <p className="flex flex-wrap items-baseline gap-x-2.5">
              {row.workflow_id ? (
                <Link href={`/workflows/${row.workflow_id}/executions/${row.execution_id}`} className="font-mono underline">{row.prospect_id}</Link>
              ) : (
                <span className="font-mono">{row.prospect_id}</span>
              )}
              <span className="text-gray-600">{heldSince(row.held_at, zone)}</span>
            </p>
            <p>
              {reasonLabel(row.reason)}
              {row.detail ? <span className="text-gray-600"> {row.detail}</span> : null}
            </p>
            {actions(row)}
          </li>
        ))}
      </ul>
      {removing && removingRow && (
        <Dialog
          title={`Remove ${removing.prospect} from the list?`}
          description={`${removing.losses.join(' ')} The sale stays marked sent.`}
          warning
          onDismiss={() => setPending(null)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => remove(removingRow)}>Remove it</Button>
            </>
          }
        />
      )}
    </div>
  )
}
