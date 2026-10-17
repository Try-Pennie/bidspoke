'use client'

/**
 * The Buyer profile section of the partner page (#1412, Phase 5 PR 2).
 *
 * The profile document and the accept rules are the partner form's state, so
 * one Save writes the partner record first (the rules live there) and the
 * profile second; this section renders the editors over that state and owns
 * the read surfaces beside them (usage, the unresolved queue; its history is on
 * the History tab since #2137) and the
 * actions that are its own: settling a sale, and for a click buyer releasing a
 * held click (#1552), which takes the unresolved queue's place because a click
 * buyer never reserves in the ledger.
 *
 * Ordered as the settled design orders it (L609, #2325): a click buyer is
 * Enabled, Sold on, Eligibility, Hours, Caps, Click delivery, Sale, Held
 * clicks, Blackout dates; an offer buyer is Enabled, Sold on, Priority,
 * Eligibility, Hours, Pricing, Caps, Sale, Unresolved sales, Outcome rules,
 * Blackout dates. Every fact once (L605): the scope
 * of the caps is said in the grid, the other sellers in the usage panel, the
 * priority direction on the priority field.
 *
 * Enabled to Caps are drawn as the settled design draws them (#2324, PM-21,
 * docs/design/partners-page.html frames 1, 19 and 20): Enabled on its own row
 * ("Offered leads"), Sold on as Offer or Click with one sentence for the one
 * chosen, Priority with where the buyer stands today among the other offer
 * buyers, Eligibility as state chips and money boxes reading None when empty,
 * Hours as the same hours every day with the time zone under them, and a click
 * buyer's cap as a narrow box with its count as a bar. A buyer with no saved
 * profile says it is not offered leads through buyer selection, with Set up a
 * buyer profile, until the person sets one up.
 *
 * Click delivery to Blackout dates, Pricing, an offer buyer's caps and
 * Unresolved sales are drawn as the design draws them (#2325, PM-22, frames 1,
 * 13 and 19): flat click routes, Sale its own section, outcome rules as rows
 * for an offer buyer, one Engine leads pricing table, the caps as a table,
 * unresolved sales as cards, and blackout dates as a list with weekdays.
 */
import { useEffect, useState } from 'react'
import { DEFAULT_DISPLAY_TIME_ZONE, DISPLAY_TIME_ZONE_LABELS, DISPLAY_TIME_ZONES, isDisplayTimeZone, PRIORITY_DIRECTION, SALE_RECORD_LABELS, SOLD_ON, salesforceStandingOf, type BuyerProfileDocument, type ProfileError, type SaleWrites, type Signal } from '@bidspoke/buyer-profile'
import { soldOnPatch } from './sold-on-switch'
import type { SignalRules } from '@/app/(app)/partners/partner-draft'
import { api, type HeldClick, type MarkSentResult, type OfferBuyer } from '@/lib/api'
import { errorSentence } from '@/lib/error-sentence'
import { Button, ChoiceGroup, Field, FieldError, MoneyInput, NumberInput, describedBy, type OutcomeState } from '@/components/ui/form'
import { Toggle } from '@/components/ui/Toggle'
import { Select } from '@/components/ui/Select'
import { AcceptRulesEditor } from './AcceptRulesEditor'
import { BlackoutDatesEditor } from './BlackoutDatesEditor'
import { DeclineRulesEditor } from './DeclineRulesEditor'
import { BuyerUsagePanel, type BuyerUsage } from './BuyerUsagePanel'
import { ClickUsagePanel, type ClickUsage } from './ClickUsagePanel'
import { CapsGrid, type CapsErrors } from './CapsGrid'
import { ClickDeliveryEditor } from './ClickDeliveryEditor'
import { HeldClicksPanel } from './HeldClicksPanel'
import { PricingTiersEditor } from './PricingTiersEditor'
import { StatePicker } from './StatePicker'
import { UnresolvedSalesList, type SettleOutcome, type UnresolvedSale } from './UnresolvedSalesList'
import { WeeklyHoursEditor } from './WeeklyHoursEditor'
import { blackoutZoneNote } from './display-zone'
import { FIELD_LABELS, SECTION_LABELS, SOLD_ON_LABELS, SOLD_ON_WHY, priorityStanding } from './labels'
import { LiveSectionNote } from '../live/PartnerLive'
import { PartnerSection } from '../PartnerSection'
import { formatCalendarDay } from '@/lib/dates'

export const EMPTY_PROFILE: BuyerProfileDocument = {
  // No preselected answer (#1541): the person chooses, and the save refuses until they do.
  sold_on: null,
  is_enabled: false,
  priority: null,
  allowed_states: [],
  debt_min: null,
  debt_max: null,
  loan_amount_min: null,
  collections_max_percent: null,
  hourly_lead_cap: null,
  daily_lead_cap: null,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: null,
  windows: [],
  blackout_dates: [],
  tiers: [],
}

interface Props {
  partnerId: string | null
  partnerName: string
  /** null while loading; the document once loaded (EMPTY_PROFILE for a partner with none yet). */
  profile: BuyerProfileDocument | null
  loadError: string | null
  onProfileChange: (next: BuyerProfileDocument) => void
  /** The validator's refusals, and the partner numbers the save refused (#2328), by path. */
  errors: readonly ShownError[]
  acceptSignals: Signal[]
  onAcceptSignalsChange: (next: Signal[]) => void
  /** The duplicate rules (#1416): decline answers that mean the buyer already holds the lead. On the partner record, beside the accept rules. */
  duplicateSignals: Signal[]
  onDuplicateSignalsChange: (next: Signal[]) => void
  /** The Salesforce routing code as typed (#1416); the partner record field the prospect patch carries on every sale. */
  externalRoutingCode: string
  onExternalRoutingCodeChange: (next: string) => void
  signalRules: SignalRules
  onSignalRulesChange: (next: SignalRules) => void
  otherSellers: Array<{ id: string; name: string }>
  /** The org's other buyers sold on the offer (#2324); undefined when the Worker did not say. */
  offerBuyers?: OfferBuyer[]
  /** The person chose to set up a profile for a buyer with none saved (#2324): the form shows in place of the no profile note. */
  setUp?: boolean
  onSetUp?: () => void
  /**
   * Why the kind cannot be switched now, or null when it can (#1541): a stored
   * profile with pricing or accept rules stored keeps its kind until they are
   * removed and saved. save_buyer_profile refuses the same switch.
   */
  soldOnLock: string | null
}

const SOLD_ON_OPTIONS = SOLD_ON.map((value) => ({ value, label: SOLD_ON_LABELS[value] }))

/** The zones the hours and reset times can be shown in (#2143, PM-10), by name, never the identifier (L611). */
const ZONE_OPTIONS = DISPLAY_TIME_ZONES.map((value) => ({ value, label: `${DISPLAY_TIME_ZONE_LABELS[value]} time` }))

/** A refusal as the section shows it: the profile validator's, or a partner number's (#2328), keyed by path. */
type ShownError = Pick<ProfileError, 'path' | 'message'>

function errorFor(errors: readonly ShownError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message
}

function errorsByPath(errors: readonly ShownError[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of errors) out[e.path] ??= e.message
  return out
}

/** Rows per read of this buyer's unresolved queue; the API's ceiling. */
const UNRESOLVED_PAGE = 100

function toUnresolvedSale(e: Record<string, unknown>, partnerName: string): UnresolvedSale {
  return {
    id: String(e.id), lead_key: String(e.lead_key), kind: String(e.kind), payout_cents: Number(e.payout_cents),
    reserved_at: String(e.reserved_at), http_status: typeof e.http_status === 'number' ? e.http_status : null,
    result_code: typeof e.result_code === 'string' ? e.result_code : null, partner_name: partnerName,
  }
}

/** A Pacific date as the count names it, 2027-09-20, shown as Sep 20. */
const countDay = formatCalendarDay

const LIST_NOT_CLEARED = ' The entry was not removed from this list; reload to see it as it stands.'

/**
 * What the Salesforce updates did, in one sentence. A complete set names the
 * records updated; anything else points at the per record list under it, which
 * carries the reasons, so they are not said twice (L605).
 */
function salesforceSentence(writes: SaleWrites): string {
  if (!writes.complete) return ' Salesforce was not fully updated; the records are listed below with a retry.'
  const updated = writes.writes.filter((w) => w.outcome === 'written').map((w) => SALE_RECORD_LABELS[w.record])
  return updated.length ? ` Salesforce updated: ${updated.join(', ')}.` : ''
}

/** Said when the audit entry, the only record of the Salesforce outcome, did not land. */
const AUDIT_NOT_RECORDED = ' The record of these Salesforce updates could not be saved, so after a reload this page will not know them.'

/**
 * The reason after a count sentence's colon, ended as a sentence without
 * doubling a full stop it already carries. With no reason, the sentence ends
 * at the colon's place instead of on a bare full stop.
 */
const reasonOf = (message: string | undefined): string => {
  const text = (message ?? '').trim()
  if (text === '') return '.'
  return `: ${/[.!?]$/.test(text) ? text : `${text}.`}`
}

/**
 * The not-removed note, only where the entry was meant to leave the list: its
 * updates all landed AND it has a lead id. A sale with no lead id stays listed
 * on purpose (#2139), so the id can be added.
 */
function notClearedNote(writes: SaleWrites, leadId: string | null, listCleared: boolean): string {
  return !listCleared && writes.complete && leadId !== null ? LIST_NOT_CLEARED : ''
}

function markSentMessage(result: MarkSentResult, leadId: string | null, partnerName: string): string {
  const base = leadId === null ? `Marked sent with no lead id from ${partnerName}.` : `Marked sent as ${leadId}.`
  const counted = result.count
    ? result.count.added
      ? ` Counted in ${partnerName}'s clicks for ${countDay(result.count.date)} (Pacific).`
      : ` It was already counted in ${partnerName}'s clicks for ${countDay(result.count.date)} (Pacific).`
    : result.count_failure === 'not_added'
      ? ` It could not be added to ${partnerName}'s clicks for ${countDay(result.count_date)} (Pacific)${reasonOf(result.count_error)}`
      // An add that got no answer may still have landed (#1766), so only a refusal says it was not added.
      : ` It may not have been added to ${partnerName}'s clicks for ${countDay(result.count_date)} (Pacific)${reasonOf(result.count_error)}`
  // An entry kept for its Salesforce retry, or for a lead id still to add, is kept on purpose.
  const notCleared = notClearedNote(result.salesforce, leadId, result.list_cleared)
  return `${base}${counted}${salesforceSentence(result.salesforce)}${result.audit_recorded ? '' : AUDIT_NOT_RECORDED}${notCleared}`
}

export function BuyerProfileSection(props: Props) {
  const { partnerId, partnerName, profile, loadError, onProfileChange, errors, acceptSignals, onAcceptSignalsChange, duplicateSignals, onDuplicateSignalsChange, externalRoutingCode, onExternalRoutingCodeChange, signalRules, onSignalRulesChange, otherSellers, soldOnLock, offerBuyers, setUp = false, onSetUp } = props
  const [usage, setUsage] = useState<BuyerUsage | ClickUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [unresolved, setUnresolved] = useState<{ rows: UnresolvedSale[]; total: number; page: number } | null>(null)
  const [unresolvedError, setUnresolvedError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** A failed Show more, kept apart from the first read's error so the rows already shown stay on screen with their controls. */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [settleOutcomes, setSettleOutcomes] = useState<Record<string, OutcomeState>>({})
  const [held, setHeld] = useState<{ entries: HeldClick[]; total: number } | null>(null)
  const [heldError, setHeldError] = useState<string | null>(null)
  const [heldOutcomes, setHeldOutcomes] = useState<Record<string, OutcomeState>>({})

  useEffect(() => {
    if (!partnerId) return
    let cancelled = false
    // This buyer's queue only, with the API's own total for it (#1457, L16): the
    // filter and the count come from one query, so "Showing N of M" is about the
    // rows the button can reach.
    api.buyerSales.list({ status: 'unresolved', page: 1, limit: UNRESOLVED_PAGE, partner_id: partnerId })
      .then((r) => {
        if (cancelled) return
        setUnresolved({ rows: r.entries.map((e) => toUnresolvedSale(e, partnerName)), total: r.total, page: 1 })
      })
      .catch((err: unknown) => { if (!cancelled) setUnresolvedError(errorSentence(err, 'The unresolved sales could not be read.')) })
    return () => { cancelled = true }
  }, [partnerId, partnerName])

  // Read once the profile is known, and again after each save. The route answers
  // by the SAVED kind (#1543): an offer buyer's ledger counts, or a click buyer's
  // clicks today from its click counter, since a click buyer never reserves in
  // the ledger and its counts there would read as zero sales against a cap that
  // counts clicks. Keyed on the saved version, never on the kind being edited
  // (#1557): choosing a kind is not a save, and the route would answer the old one.
  const profileLoaded = profile !== null
  const savedVersion = profile?.version ?? 0
  useEffect(() => {
    if (!partnerId || !profileLoaded) return
    let cancelled = false
    setUsage(null)
    setUsageError(null)
    // The route's own sentence, never the error code req() puts in the message (#1557).
    api.buyerProfiles.usage(partnerId).then((u) => { if (!cancelled) setUsage(u) }).catch((err: unknown) => { if (!cancelled) setUsageError(errorSentence(err, 'The usage counts could not be read.')) })
    return () => { cancelled = true }
  }, [partnerId, profileLoaded, savedVersion])

  // A click buyer's held clicks (#1552), read once the profile says it is sold on the click.
  const soldOnClick = profile !== null && profile.sold_on === 'click'
  useEffect(() => {
    if (!partnerId || !soldOnClick) return
    let cancelled = false
    api.heldClicks.list(partnerId)
      .then((r) => { if (!cancelled) setHeld(r) })
      .catch((err: unknown) => { if (!cancelled) setHeldError(errorSentence(err, 'the read failed')) })
    return () => { cancelled = true }
  }, [partnerId, soldOnClick])

  /** Runs one release with the three visible states (working with a clock, done, failed) on its card. */
  async function release(id: string, label: string, act: () => Promise<string>) {
    const startedAt = Date.now()
    setHeldOutcomes((o) => ({ ...o, [id]: { kind: 'working', label, startedAt, now: startedAt, stalledAfterMs: 30_000 } }))
    const tick = setInterval(() => setHeldOutcomes((o) => (o[id]?.kind === 'working' ? { ...o, [id]: { ...o[id], now: Date.now() } as OutcomeState } : o)), 1000)
    try {
      const message = await act()
      setHeldOutcomes((o) => ({ ...o, [id]: { kind: 'done', message } }))
    } catch (err) {
      setHeldOutcomes((o) => ({ ...o, [id]: { kind: 'failed', message: errorSentence(err, 'The release failed.') } }))
    } finally {
      clearInterval(tick)
    }
  }

  /** Puts what a release returned on its card, so the card's controls follow the claim and its Salesforce updates without a reload. */
  const patchHeld = (id: string, patch: Partial<HeldClick>) =>
    setHeld((h) => (h ? { ...h, entries: h.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : h))

  /**
   * What a sale's new Salesforce writes leave on its card: the writes, where the
   * sale now stands by the rule the list reads it by (L342), and whether the
   * entry left the list, so the card offers nothing on an entry that is gone.
   */
  const soldPatch = (generation: number, leadId: string | null, writes: SaleWrites, listCleared: boolean): Partial<HeldClick> => {
    const salesforce = { status: 'recorded' as const, at: new Date().toISOString(), writes }
    return {
      claim: { status: 'sold', generation, partner_lead_id: leadId },
      salesforce,
      salesforce_standing: salesforceStandingOf(salesforce, leadId),
      cleared: listCleared,
    }
  }

  const markSent = (row: HeldClick, generation: number, leadId: string | null) =>
    release(row.id, 'Marking it sent', async () => {
      const r = await api.heldClicks.markSent(row.id, generation, leadId)
      patchHeld(row.id, { ...soldPatch(r.generation, leadId, r.salesforce, r.list_cleared), counted: r.count !== null })
      return markSentMessage(r, leadId, partnerName)
    })
  const retrySalesforce = (row: HeldClick) =>
    release(row.id, 'Updating Salesforce', async () => {
      const r = await api.heldClicks.retrySalesforce(row.id)
      // The retry writes the lead id the claim holds, so the card keeps it.
      const claim = row.claim.status === 'sold' ? row.claim : null
      if (claim) patchHeld(row.id, soldPatch(claim.generation, claim.partner_lead_id, r.salesforce, r.list_cleared))
      else patchHeld(row.id, { salesforce: { status: 'recorded', at: new Date().toISOString(), writes: r.salesforce } })
      const unrecorded = r.audit_recorded ? '' : AUDIT_NOT_RECORDED
      if (!r.salesforce.complete) return `Retried. Salesforce was still not fully updated; the records are listed below.${unrecorded}`
      return `Retried.${salesforceSentence(r.salesforce)}${unrecorded}${notClearedNote(r.salesforce, claim?.partner_lead_id ?? null, r.list_cleared)}`
    })
  /** Add or correct a marked sent sale's lead id (#2139, L1008); a refusal is shown in the route's own words. */
  const setLeadId = (row: HeldClick, generation: number, leadId: string) =>
    release(row.id, 'Saving the lead id', async () => {
      const old = row.claim.status === 'sold' ? row.claim.partner_lead_id : null
      const r = await api.heldClicks.setLeadId(row.id, generation, leadId)
      patchHeld(row.id, soldPatch(r.generation, leadId, r.salesforce, r.list_cleared))
      const base = old ? `Lead id changed from ${old} to ${leadId}.` : `Lead id ${leadId} added.`
      return `${base}${salesforceSentence(r.salesforce)}${r.audit_recorded ? '' : AUDIT_NOT_RECORDED}${notClearedNote(r.salesforce, leadId, r.list_cleared)}`
    })
  const free = (row: HeldClick, generation: number) =>
    release(row.id, 'Freeing it', async () => {
      const r = await api.heldClicks.free(row.id, generation)
      return `Freed. The next click on this prospect sends it to ${partnerName}.${r.list_cleared ? '' : LIST_NOT_CLEARED}`
    })
  const clear = (row: HeldClick) =>
    release(row.id, 'Removing it', async () => {
      const r = await api.heldClicks.clear(row.id)
      if (r.list_cleared) patchHeld(row.id, { cleared: true })
      return r.list_cleared ? 'Removed from the list.' : LIST_NOT_CLEARED.trim()
    })

  async function loadMoreUnresolved() {
    if (!partnerId || !unresolved || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const r = await api.buyerSales.list({ status: 'unresolved', page: unresolved.page + 1, limit: UNRESOLVED_PAGE, partner_id: partnerId })
      setUnresolved((u) => (u ? { rows: [...u.rows, ...r.entries.map((e) => toUnresolvedSale(e, partnerName))], total: r.total, page: u.page + 1 } : u))
    } catch (err) {
      setLoadMoreError(`The rest of the unresolved sales could not be read: ${errorSentence(err, 'the read failed')}`)
    } finally {
      setLoadingMore(false)
    }
  }

  async function settle(id: string, outcome: SettleOutcome) {
    const startedAt = Date.now()
    setSettleOutcomes((o) => ({ ...o, [id]: { kind: 'working', label: 'Settling', startedAt, now: startedAt, stalledAfterMs: 30_000 } }))
    const tick = setInterval(() => setSettleOutcomes((o) => (o[id]?.kind === 'working' ? { ...o, [id]: { ...o[id], now: Date.now() } as OutcomeState } : o)), 1000)
    try {
      const result = await api.buyerSales.settle(id, outcome)
      const message = outcome === 'accepted' ? `Counted as sold to ${partnerName}.` : 'Released. The slot is free.'
      setSettleOutcomes((o) => ({ ...o, [id]: { kind: 'done', message: result.mirrored ? message : `${message} The record copy is behind; it will catch up within a minute.` } }))
    } catch (err) {
      setSettleOutcomes((o) => ({ ...o, [id]: { kind: 'failed', message: errorSentence(err, 'The settlement failed.') } }))
    } finally {
      clearInterval(tick)
    }
  }

  const patch = (next: Partial<BuyerProfileDocument>) => { if (profile) onProfileChange({ ...profile, ...next }) }
  const byPath = errorsByPath(errors)
  const capErrors: CapsErrors = {
    hourlyLeadCap: byPath.hourlyLeadCap, dailyLeadCap: byPath.dailyLeadCap,
    hourlySpendCapCents: byPath.hourlySpendCapCents, dailySpendCapCents: byPath.dailySpendCapCents,
  }
  const acceptRefusal = errorFor(errors, 'acceptSignals') ?? errorFor(errors, 'accept_signals') ?? null
  const click = profile?.sold_on === 'click'
  const soldOnError = errorFor(errors, 'soldOn')
  // The validator names the routing code by its rule key, the partner number rule by its column (#2328).
  const routingCodeRefusal = errorFor(errors, 'external_routing_code') ?? errorFor(errors, 'externalRoutingCode') ?? null
  const statusRefusal = errorFor(errors, 'response_classification') ?? null
  // Where the hours and reset times are shown; unset shows Eastern, the zone they are stored and judged in.
  const zone = profile?.display_time_zone ?? DEFAULT_DISPLAY_TIME_ZONE
  const blackoutNote = blackoutZoneNote(zone)

  const offerStanding = priorityStanding(partnerName, offerBuyers, profile?.is_enabled ?? false)
  const caps = { hourly_lead_cap: profile?.hourly_lead_cap ?? null, daily_lead_cap: profile?.daily_lead_cap ?? null, hourly_spend_cap_cents: profile?.hourly_spend_cap_cents ?? null, daily_spend_cap_cents: profile?.daily_spend_cap_cents ?? null }
  const anyCap = Object.values(caps).some((v) => v !== null)
  const storedRulesOnClick = signalRules.rejection.length > 0 || duplicateSignals.length > 0
  // A buyer with no saved profile is not offered leads through buyer selection, and says so until the person sets one up (#2324).
  const noProfile = profile !== null && (profile.version ?? 0) === 0 && !setUp
  const clickMeter = usage === null && usageError === null ? (
    <p role="status" className="text-xs text-hint">Reading the usage counts…</p>
  ) : usageError === null && usage !== null && usage.sold_on !== 'click' ? (
    // An unsaved change of kind (#1557): nothing is wrong, the route answers the saved kind.
    <p role="status" className="text-xs text-gray-600">The clicks show once the change to the click is saved.</p>
  ) : (
    <ClickUsagePanel usage={usage?.sold_on === 'click' ? usage : null} error={usageError} cap={profile?.daily_lead_cap ?? null} otherSellers={otherSellers} partnerName={partnerName} />
  )

  return (
    <section aria-label="Buyer profile">
      {!partnerId ? (
        <p className="text-sm text-gray-600">Save the partner first. The buyer profile is kept against the saved partner.</p>
      ) : loadError ? (
        <FieldError alert size="sm">The buyer profile could not be read: {loadError}</FieldError>
      ) : !profile ? (
        <p role="status" className="text-sm text-gray-600">Reading the buyer profile…</p>
      ) : noProfile ? (
        <PartnerSection title="No buyer profile">
          <p className="text-[13px] text-hint">{partnerName} is not offered leads through buyer selection.</p>
          <div>
            <Button variant="primary" onClick={onSetUp}>Set up a buyer profile</Button>
          </div>
        </PartnerSection>
      ) : (
        <>
          <PartnerSection title={FIELD_LABELS.is_enabled}>
            <LiveSectionNote sections={['Enabled']} />
            <div className="flex items-center gap-2.5">
              <Toggle id="bp-enabled" checked={profile.is_enabled} onChange={(v) => patch({ is_enabled: v })} label="Offered leads" />
              <label htmlFor="bp-enabled" className="text-[13.5px] text-graphite">Offered leads</label>
            </div>
            {errorFor(errors, 'isEnabled') && <FieldError alert size="xs">{errorFor(errors, 'isEnabled')}</FieldError>}
          </PartnerSection>

          {/* The answer decides which of the rules below apply (#1541, L609). */}
          <PartnerSection title={FIELD_LABELS.sold_on}>
            <LiveSectionNote sections={['Sold on']} />
            <ChoiceGroup
              id="bp-sold-on"
              label={FIELD_LABELS.sold_on}
              visibleLabel=""
              value={profile.sold_on}
              options={SOLD_ON_OPTIONS}
              onChange={(sold_on) => patch(soldOnPatch(sold_on))}
              disabled={soldOnLock !== null}
              describedBy={['bp-sold-on-hint', soldOnLock ? 'bp-sold-on-lock' : null, soldOnError ? 'bp-sold-on-error' : null].filter(Boolean).join(' ')}
            />
            {/* One sentence for the kind chosen; before either is chosen, one for each, so the choice can be made. */}
            <p id="bp-sold-on-hint" className="text-xs text-hint">
              {profile.sold_on ? SOLD_ON_WHY[profile.sold_on] : SOLD_ON.map((k) => `${SOLD_ON_LABELS[k]}: ${SOLD_ON_WHY[k].charAt(0).toLowerCase()}${SOLD_ON_WHY[k].slice(1)}`).join(' ')}
            </p>
            {soldOnLock && <p id="bp-sold-on-lock" className="text-xs text-gray-600">{soldOnLock}</p>}
            {soldOnError && <FieldError id="bp-sold-on-error" alert size="xs">{soldOnError}</FieldError>}
          </PartnerSection>

          {/* A click buyer is never ranked: buyer selection does not offer it a lead (#1541). */}
          {!click && (
            <PartnerSection title={FIELD_LABELS.priority} region={false}>
              <LiveSectionNote sections={['Priority']} />
              <Field id="bp-priority" label={FIELD_LABELS.priority} labelHidden hint={PRIORITY_DIRECTION} error={errorFor(errors, 'priority')}>
                <NumberInput id="bp-priority" value={profile.priority} onChange={(v) => patch({ priority: v })} min={1} describedBy={[describedBy('bp-priority', true, Boolean(errorFor(errors, 'priority'))), offerStanding ? 'bp-priority-standing' : null].filter(Boolean).join(' ')} className="w-[7.5rem]" />
              </Field>
              {offerStanding && <p id="bp-priority-standing" className="text-xs text-hint">{offerStanding}</p>}
            </PartnerSection>
          )}

          <PartnerSection title="Eligibility">
            <LiveSectionNote sections={['Eligibility']} />
            <StatePicker value={profile.allowed_states} onChange={(states) => patch({ allowed_states: states })} />
            {errorFor(errors, 'allowedStates') && <FieldError alert size="xs">{errorFor(errors, 'allowedStates')}</FieldError>}
            {/* Two rows of two (#2268, settled 2026-10-17): the debt range, then the loan minimum and the collections cap. An empty box reads None (#2324). */}
            <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
              <Field id="bp-debt-min" label={FIELD_LABELS.debt_min} error={errorFor(errors, 'debtMin')}>
                <MoneyInput id="bp-debt-min" value={profile.debt_min} onChange={(v) => patch({ debt_min: v })} placeholder="None" describedBy={describedBy('bp-debt-min', false, Boolean(errorFor(errors, 'debtMin')))} />
              </Field>
              <Field id="bp-debt-max" label={FIELD_LABELS.debt_max} error={errorFor(errors, 'debtMax')}>
                <MoneyInput id="bp-debt-max" value={profile.debt_max} onChange={(v) => patch({ debt_max: v })} placeholder="None" describedBy={describedBy('bp-debt-max', false, Boolean(errorFor(errors, 'debtMax')))} />
              </Field>
              <Field id="bp-loan-min" label={FIELD_LABELS.loan_amount_min} error={errorFor(errors, 'loanAmountMin')}>
                <MoneyInput id="bp-loan-min" value={profile.loan_amount_min} onChange={(v) => patch({ loan_amount_min: v })} placeholder="None" describedBy={describedBy('bp-loan-min', false, Boolean(errorFor(errors, 'loanAmountMin')))} />
              </Field>
              {/* Only the number is typed; "% of debt" is fixed text beside the box (Dan, 2026-10-17). */}
              <Field id="bp-collections-max" label={FIELD_LABELS.collections_max_percent} error={errorFor(errors, 'collectionsMaxPercent')}>
                <div className="flex items-center gap-2">
                  <NumberInput id="bp-collections-max" value={profile.collections_max_percent ?? null} onChange={(v) => patch({ collections_max_percent: v })} min={0} placeholder="None" describedBy={['bp-collections-max-unit', 'bp-eligibility-hint', describedBy('bp-collections-max', false, Boolean(errorFor(errors, 'collectionsMaxPercent')))].filter(Boolean).join(' ')} className="w-24" />
                  <span id="bp-collections-max-unit" className="text-sm text-graphite">% of debt</span>
                </div>
              </Field>
            </div>
            <p id="bp-eligibility-hint" className="text-xs text-hint">A lead whose collections are more than this share of its debt is skipped. Empty means no limit.</p>
          </PartnerSection>

          <PartnerSection title={SECTION_LABELS.windows}>
            <LiveSectionNote sections={[SECTION_LABELS.windows]} />
            <WeeklyHoursEditor value={profile.windows} onChange={(windows) => patch({ windows })} zone={zone} />
            {errorFor(errors, 'windows') && <FieldError alert size="xs">{errorFor(errors, 'windows')}</FieldError>}
            {/* Changes only how times are shown: the hours stay stored and judged in Eastern (#2143, PM-10). */}
            <div className="flex items-center gap-2.5">
              <label htmlFor="bp-display-time-zone" className="text-xs text-gray-600">{FIELD_LABELS.display_time_zone}</label>
              <Select
                id="bp-display-time-zone"
                value={zone}
                options={ZONE_OPTIONS}
                onChange={(z) => { if (isDisplayTimeZone(z)) patch({ display_time_zone: z }) }}
                describedBy={errorFor(errors, 'displayTimeZone') ? 'bp-display-time-zone-error' : undefined}
                className="w-40"
              />
            </div>
            {errorFor(errors, 'displayTimeZone') && <FieldError id="bp-display-time-zone-error" alert size="xs">{errorFor(errors, 'displayTimeZone')}</FieldError>}
          </PartnerSection>

          {/* A click buyer is quoted at the Engine bid, so it has no pricing (#1541). */}
          {!click && (
            <PartnerSection title={SECTION_LABELS.tiers}>
              <LiveSectionNote sections={[SECTION_LABELS.tiers]} />
              <PricingTiersEditor value={profile.tiers} onChange={(tiers) => patch({ tiers })} errors={byPath} />
              {errorFor(errors, 'tiers') && <FieldError alert size="xs">{errorFor(errors, 'tiers')}</FieldError>}
            </PartnerSection>
          )}

          <PartnerSection title="Caps">
            <LiveSectionNote sections={['Caps']} />
            <CapsGrid
              value={caps}
              onChange={(next) => patch(next)}
              errors={capErrors}
              soldOn={profile.sold_on}
              zone={zone}
              partnerName={partnerName}
              meter={click ? clickMeter : undefined}
            />
            {/* An offer buyer's counts against its caps, shown only while a cap is set: with none there is nothing to count against (#2325). */}
            {click || !anyCap ? null : usage === null && usageError === null ? (
              <p role="status" className="text-xs text-hint">Reading the usage counts…</p>
            ) : usageError === null && usage !== null && profile.sold_on !== null && usage.sold_on !== profile.sold_on ? (
              // An unsaved change of kind (#1557): nothing is wrong, the route answers the saved kind.
              <p role="status" className="text-xs text-gray-600">The ledger counts show once the change to the offer is saved.</p>
            ) : (
              <BuyerUsagePanel
                usage={usage?.sold_on === 'offer' ? usage : null}
                error={usageError}
                caps={caps}
                otherSellers={otherSellers}
                partnerName={partnerName}
              />
            )}
          </PartnerSection>

          {/* Where a click buyer's clicks are posted and the reply that counts as sold (#1639). */}
          {click && (
            <PartnerSection title="Click delivery">
              <LiveSectionNote sections={['Click delivery']} />
              <ClickDeliveryEditor value={profile.click_delivery} onChange={(click_delivery) => patch({ click_delivery })} errors={byPath} />
            </PartnerSection>
          )}

          {/* What every sale to this buyer carries to Salesforce (#2325: its own section, as designed). */}
          <PartnerSection title="Sale">
            <LiveSectionNote sections={['Sale']} />
            <Field id="bp-routing-code" label={FIELD_LABELS.external_routing_code} error={routingCodeRefusal}>
              <NumberInput id="bp-routing-code" value={externalRoutingCode === '' ? null : Number(externalRoutingCode)} onChange={(v) => onExternalRoutingCodeChange(v === null ? '' : String(v))} min={0} describedBy={describedBy('bp-routing-code', false, Boolean(routingCodeRefusal))} className="w-[7.5rem]" />
            </Field>
          </PartnerSection>

          {/* A click buyer never reserves in the ledger, so its queue is its held clicks (#1552). */}
          {click && (
            <PartnerSection title="Held clicks">
              <HeldClicksPanel partnerName={partnerName} zone={zone} held={held} error={heldError} outcomes={heldOutcomes} onMarkSent={markSent} onFree={free} onClear={clear} onRetrySalesforce={retrySalesforce} onSetLeadId={setLeadId} />
            </PartnerSection>
          )}

          {!click && (
            <PartnerSection title="Unresolved sales">
              {unresolvedError ? (
                <FieldError alert size="xs">{unresolvedError}</FieldError>
              ) : unresolved === null ? (
                <p role="status" className="text-xs text-hint">Reading the unresolved sales…</p>
              ) : (
                <>
                  <UnresolvedSalesList rows={unresolved.rows} total={unresolved.total} onSettle={settle} outcomes={settleOutcomes} onMore={loadMoreUnresolved} loadingMore={loadingMore} zone={zone} />
                  {loadMoreError && <FieldError alert size="xs">{loadMoreError}</FieldError>}
                </>
              )}
            </PartnerSection>
          )}

          {/*
            An offer buyer's sale is judged by these rules; a click buyer's by its
            success reply, so the section is not shown for one (#1541, #2325),
            unless it still holds a decline or duplicate rule, which stays on
            screen so it can be seen and removed (L1008).
          */}
          {(!click || storedRulesOnClick) && (
            <PartnerSection title="Outcome rules">
              <LiveSectionNote sections={['Outcome rules']} />
              <div className="space-y-3">
                {!click && <AcceptRulesEditor value={acceptSignals} onChange={onAcceptSignalsChange} refusal={acceptRefusal} />}
                <DeclineRulesEditor value={signalRules} onChange={onSignalRulesChange} />
                {statusRefusal && <FieldError alert size="xs">{statusRefusal}</FieldError>}
                <AcceptRulesEditor kind="duplicate" value={duplicateSignals} onChange={onDuplicateSignalsChange} />
              </div>
            </PartnerSection>
          )}

          <PartnerSection title={SECTION_LABELS.blackout_dates}>
            <LiveSectionNote sections={[SECTION_LABELS.blackout_dates]} />
            <BlackoutDatesEditor value={profile.blackout_dates} onChange={(blackout_dates) => patch({ blackout_dates })} errors={byPath} />
            <p className="text-xs text-hint">{blackoutNote ?? 'Whole days, Eastern.'}</p>
          </PartnerSection>
        </>
      )}
    </section>
  )
}
