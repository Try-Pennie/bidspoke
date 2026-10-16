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
 * Ordered for the reader (L609): enabled and ranking first, pricing and caps
 * next, outcome rules, blackout dates last. Every fact once (L605): the scope
 * of the caps is said in the grid, the other sellers in the usage panel, the
 * priority direction on the priority field.
 */
import { useEffect, useState } from 'react'
import { DEFAULT_DISPLAY_TIME_ZONE, DISPLAY_TIME_ZONE_LABELS, DISPLAY_TIME_ZONES, isDisplayTimeZone, PRIORITY_DIRECTION, SALE_RECORD_LABELS, SOLD_ON, type BuyerProfileDocument, type ProfileError, type SaleWrites, type Signal } from '@bidspoke/buyer-profile'
import { soldOnPatch } from './sold-on-switch'
import type { SignalRules } from '@/app/(app)/partners/partner-draft'
import { api, type HeldClick, type MarkSentResult } from '@/lib/api'
import { errorSentence } from '@/lib/error-sentence'
import { ChoiceGroup, Field, NumberInput, describedBy, type OutcomeState } from '@/components/ui/form'
import { Toggle } from '@/components/ui/Toggle'
import { Select } from '@/components/ui/Select'
import { SignalRuleBuilder, SIGNAL_SECTIONS } from '@/components/partners/SignalRuleBuilder'
import { AcceptRulesEditor } from './AcceptRulesEditor'
import { BlackoutDatesEditor } from './BlackoutDatesEditor'
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
import { FIELD_LABELS, SECTION_LABELS, SOLD_ON_LABELS } from './labels'
import { LiveSectionNote } from '../live/PartnerLive'
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
  errors: readonly ProfileError[]
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
  /**
   * Why the kind cannot be switched now, or null when it can (#1541): a stored
   * profile with pricing or accept rules stored keeps its kind until they are
   * removed and saved. save_buyer_profile refuses the same switch.
   */
  soldOnLock: string | null
}

const SOLD_ON_OPTIONS = SOLD_ON.map((value) => ({ value, label: SOLD_ON_LABELS[value] }))

/** The zones the hours and reset times can be shown in (#2143, PM-10), by name, never the identifier (L611). */
const ZONE_OPTIONS = DISPLAY_TIME_ZONES.map((value) => ({ value, label: DISPLAY_TIME_ZONE_LABELS[value] }))

const DECLINE_SECTION = SIGNAL_SECTIONS.filter((s) => s.cat === 'rejection').map((s) => ({
  ...s,
  label: 'Decline when any of',
  desc: 'The buyer said no. The sale moves on to the next buyer. Main Flow\'s Bid Group reads these rules too.',
}))

function errorFor(errors: readonly ProfileError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message
}

function errorsByPath(errors: readonly ProfileError[]): Record<string, string> {
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

function markSentMessage(result: MarkSentResult, leadId: string, partnerName: string): string {
  const base = `Marked sent as ${leadId}.`
  const counted = result.count
    ? result.count.added
      ? ` Counted in ${partnerName}'s clicks for ${countDay(result.count.date)} (Pacific).`
      : ` It was already counted in ${partnerName}'s clicks for ${countDay(result.count.date)} (Pacific).`
    : result.count_failure === 'not_added'
      ? ` It could not be added to ${partnerName}'s clicks for ${countDay(result.count_date)} (Pacific)${reasonOf(result.count_error)}`
      // An add that got no answer may still have landed (#1766), so only a refusal says it was not added.
      : ` It may not have been added to ${partnerName}'s clicks for ${countDay(result.count_date)} (Pacific)${reasonOf(result.count_error)}`
  // An entry kept for its Salesforce retry is kept on purpose, so the not-removed note is only for a complete one.
  const notCleared = !result.list_cleared && result.salesforce.complete ? LIST_NOT_CLEARED : ''
  return `${base}${counted}${salesforceSentence(result.salesforce)}${result.audit_recorded ? '' : AUDIT_NOT_RECORDED}${notCleared}`
}

export function BuyerProfileSection(props: Props) {
  const { partnerId, partnerName, profile, loadError, onProfileChange, errors, acceptSignals, onAcceptSignalsChange, duplicateSignals, onDuplicateSignalsChange, externalRoutingCode, onExternalRoutingCodeChange, signalRules, onSignalRulesChange, otherSellers, soldOnLock } = props
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

  /** Runs one release with the three visible states (working with a clock, done, failed) on its row. */
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

  /** Puts what a release returned on its row, so the row's controls follow the claim and its Salesforce updates without a reload. */
  const patchHeld = (id: string, patch: Partial<HeldClick>) =>
    setHeld((h) => (h ? { ...h, entries: h.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : h))

  const markSent = (row: HeldClick, generation: number, leadId: string) =>
    release(row.id, 'Marking it sent', async () => {
      const r = await api.heldClicks.markSent(row.id, generation, leadId)
      patchHeld(row.id, {
        claim: { status: 'sold', generation: r.generation, partner_lead_id: leadId },
        salesforce: { status: 'recorded', at: new Date().toISOString(), writes: r.salesforce },
      })
      return markSentMessage(r, leadId, partnerName)
    })
  const retrySalesforce = (row: HeldClick) =>
    release(row.id, 'Updating Salesforce', async () => {
      const r = await api.heldClicks.retrySalesforce(row.id)
      patchHeld(row.id, { salesforce: { status: 'recorded', at: new Date().toISOString(), writes: r.salesforce } })
      const unrecorded = r.audit_recorded ? '' : AUDIT_NOT_RECORDED
      if (!r.salesforce.complete) return `Retried. Salesforce was still not fully updated; the records are listed below.${unrecorded}`
      return `Retried.${salesforceSentence(r.salesforce)}${unrecorded}${r.list_cleared ? '' : LIST_NOT_CLEARED}`
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
  const routingCodeRefusal = errorFor(errors, 'externalRoutingCode') ?? null
  // Where the hours and reset times are shown; unset shows Eastern, the zone they are stored and judged in.
  const zone = profile?.display_time_zone ?? DEFAULT_DISPLAY_TIME_ZONE
  const blackoutNote = blackoutZoneNote(zone)

  return (
    <section aria-label="Buyer profile" className="space-y-6 rounded-lg border border-emerald-100 bg-emerald-50/30 p-4">
      {!partnerId ? (
        <p className="text-sm text-gray-600">Save the partner first. The buyer profile is kept against the saved partner.</p>
      ) : loadError ? (
        <p role="alert" className="text-sm text-red-700">The buyer profile could not be read: {loadError}</p>
      ) : !profile ? (
        <p role="status" className="text-sm text-gray-600">Reading the buyer profile…</p>
      ) : (
        <>
          {/* First, because the answer decides which of the rules below apply (#1541, L609). */}
          <div className="space-y-1">
            <ChoiceGroup
              id="bp-sold-on"
              label={FIELD_LABELS.sold_on}
              value={profile.sold_on}
              options={SOLD_ON_OPTIONS}
              onChange={(sold_on) => patch(soldOnPatch(sold_on))}
              disabled={soldOnLock !== null}
              describedBy={['bp-sold-on-hint', soldOnLock ? 'bp-sold-on-lock' : null, soldOnError ? 'bp-sold-on-error' : null].filter(Boolean).join(' ')}
            />
            <p id="bp-sold-on-hint" className="text-xs text-gray-500">The offer: sold through buyer selection at a priced rate. The click: quoted at the Engine bid and sent to the buyer only when the person clicks.</p>
            {soldOnLock && <p id="bp-sold-on-lock" className="text-xs text-gray-600">{soldOnLock}</p>}
            {soldOnError && <p id="bp-sold-on-error" role="alert" className="text-xs text-red-700">{soldOnError}</p>}
            <LiveSectionNote sections={['Sold on']} />
          </div>

          <div className="space-y-4">
            <h4 className="text-sm font-medium text-gray-700">{click ? 'Enabled and eligibility' : 'Enabled and ranking'}</h4>
            <LiveSectionNote sections={['Enabled and ranking', 'Eligibility']} />
            <div className="flex items-center gap-3">
              <Toggle id="bp-enabled" checked={profile.is_enabled} onChange={(v) => patch({ is_enabled: v })} label="Enabled" />
              <label htmlFor="bp-enabled" className="text-sm text-graphite">Enabled</label>
              {errorFor(errors, 'isEnabled') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'isEnabled')}</p>}
            </div>
            {/* A click buyer is never ranked: buyer selection does not offer it a lead (#1541). */}
            {!click && (
              <Field id="bp-priority" label="Priority" hint={PRIORITY_DIRECTION} error={errorFor(errors, 'priority')}>
                <NumberInput id="bp-priority" value={profile.priority} onChange={(v) => patch({ priority: v })} min={1} step={1} describedBy={describedBy('bp-priority', true, Boolean(errorFor(errors, 'priority')))} className="w-32" />
              </Field>
            )}
            <StatePicker value={profile.allowed_states} onChange={(states) => patch({ allowed_states: states })} />
            {errorFor(errors, 'allowedStates') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'allowedStates')}</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field id="bp-debt-min" label="Debt minimum" hint="Dollars, inclusive." error={errorFor(errors, 'debtMin')}>
                <NumberInput id="bp-debt-min" value={profile.debt_min} onChange={(v) => patch({ debt_min: v })} min={0} describedBy={describedBy('bp-debt-min', true, Boolean(errorFor(errors, 'debtMin')))} />
              </Field>
              <Field id="bp-debt-max" label="Debt maximum" hint="Dollars, inclusive. Empty means no maximum." error={errorFor(errors, 'debtMax')}>
                <NumberInput id="bp-debt-max" value={profile.debt_max} onChange={(v) => patch({ debt_max: v })} min={0} describedBy={describedBy('bp-debt-max', true, Boolean(errorFor(errors, 'debtMax')))} />
              </Field>
              <Field id="bp-loan-min" label="Loan amount minimum" hint="Dollars. Empty means the loan amount is not read." error={errorFor(errors, 'loanAmountMin')}>
                <NumberInput id="bp-loan-min" value={profile.loan_amount_min} onChange={(v) => patch({ loan_amount_min: v })} min={0} describedBy={describedBy('bp-loan-min', true, Boolean(errorFor(errors, 'loanAmountMin')))} />
              </Field>
            </div>
            <div>
              <h5 className="mb-2 text-xs font-medium text-gray-600">{SECTION_LABELS.windows}</h5>
              <LiveSectionNote sections={[SECTION_LABELS.windows]} />
              <WeeklyHoursEditor value={profile.windows} onChange={(windows) => patch({ windows })} zone={zone} />
              {errorFor(errors, 'windows') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'windows')}</p>}
              {/* Changes only how times are shown: the hours stay stored and judged in Eastern (#2143, PM-10). */}
              <div className="mt-3 flex items-center gap-2.5">
                <label htmlFor="bp-display-time-zone" className="text-xs font-medium text-gray-600">{FIELD_LABELS.display_time_zone}</label>
                <Select
                  id="bp-display-time-zone"
                  value={zone}
                  options={ZONE_OPTIONS}
                  onChange={(z) => { if (isDisplayTimeZone(z)) patch({ display_time_zone: z }) }}
                  describedBy={errorFor(errors, 'displayTimeZone') ? 'bp-display-time-zone-error' : undefined}
                  className="w-36"
                />
              </div>
              {errorFor(errors, 'displayTimeZone') && <p id="bp-display-time-zone-error" role="alert" className="mt-1 text-xs text-red-700">{errorFor(errors, 'displayTimeZone')}</p>}
            </div>
          </div>

          {/* A click buyer is quoted at the Engine bid, so it has no pricing (#1541). */}
          {!click && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700">{SECTION_LABELS.tiers}</h4>
              <LiveSectionNote sections={[SECTION_LABELS.tiers]} />
              <PricingTiersEditor value={profile.tiers} onChange={(tiers) => patch({ tiers })} errors={byPath} />
              {errorFor(errors, 'tiers') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'tiers')}</p>}
            </div>
          )}

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Caps</h4>
            <LiveSectionNote sections={['Caps']} />
            <CapsGrid
              value={{ hourly_lead_cap: profile.hourly_lead_cap, daily_lead_cap: profile.daily_lead_cap, hourly_spend_cap_cents: profile.hourly_spend_cap_cents, daily_spend_cap_cents: profile.daily_spend_cap_cents }}
              onChange={(caps) => patch(caps)}
              errors={capErrors}
              soldOn={profile.sold_on}
              zone={zone}
            />
            {usage === null && usageError === null ? (
              <p role="status" className="text-xs text-gray-500">Reading the usage counts…</p>
            ) : usageError === null && usage !== null && profile.sold_on !== null && usage.sold_on !== profile.sold_on ? (
              // An unsaved change of kind (#1557): nothing is wrong, the route answers the saved kind.
              <p role="status" className="text-xs text-gray-600">{click ? 'The clicks show once the change to the click is saved.' : 'The ledger counts show once the change to the offer is saved.'}</p>
            ) : click ? (
              <ClickUsagePanel
                usage={usage?.sold_on === 'click' ? usage : null}
                error={usageError}
                cap={profile.daily_lead_cap}
                otherSellers={otherSellers}
                partnerName={partnerName}
              />
            ) : (
              <BuyerUsagePanel
                usage={usage?.sold_on === 'offer' ? usage : null}
                error={usageError}
                caps={{ hourly_lead_cap: profile.hourly_lead_cap, daily_lead_cap: profile.daily_lead_cap, hourly_spend_cap_cents: profile.hourly_spend_cap_cents, daily_spend_cap_cents: profile.daily_spend_cap_cents }}
                otherSellers={otherSellers}
                partnerName={partnerName}
              />
            )}
          </div>

          {/* Beside the caps, where a click buyer's count shows (#1552). */}
          {click && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Held clicks</h4>
              <HeldClicksPanel partnerName={partnerName} held={held} error={heldError} outcomes={heldOutcomes} onMarkSent={markSent} onFree={free} onClear={clear} onRetrySalesforce={retrySalesforce} />
            </div>
          )}

          {/* Where a click buyer's clicks are posted and the reply that counts as sold (#1639). */}
          {click && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Click delivery</h4>
              <LiveSectionNote sections={['Click delivery']} />
              <ClickDeliveryEditor value={profile.click_delivery} onChange={(click_delivery) => patch({ click_delivery })} errors={byPath} />
            </div>
          )}

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Outcome rules</h4>
            <LiveSectionNote sections={['Outcome rules']} />
            {/* A click buyer's sale is judged by the click workflow, never by accept rules (#1541). */}
            {!click && (
              <div>
                <p className="mb-1 text-sm font-medium text-gray-700">{SECTION_LABELS.accept_signals}</p>
                <p className="mb-2 text-xs text-gray-500">The buyer took the lead. A sale counts only when the answer is 2xx and every rule here matches.</p>
                <AcceptRulesEditor value={acceptSignals} onChange={onAcceptSignalsChange} refusal={acceptRefusal} />
              </div>
            )}
            <SignalRuleBuilder value={signalRules} onChange={onSignalRulesChange} sections={DECLINE_SECTION} />
            <div>
              <p className="mb-1 text-sm font-medium text-gray-700">{SECTION_LABELS.duplicate_signals}</p>
              <p className="mb-2 text-xs text-gray-500">The buyer already holds this lead. A decline matching any rule here is recorded in Salesforce as Duplicate; any other decline as Fail.</p>
              <AcceptRulesEditor kind="duplicate" value={duplicateSignals} onChange={onDuplicateSignalsChange} />
            </div>
            <Field id="bp-routing-code" label="Salesforce routing code" hint="Written to the prospect as ExternalRoutingCode__c on every sale to this buyer. Tripoint is 2." error={routingCodeRefusal}>
              <NumberInput id="bp-routing-code" value={externalRoutingCode === '' ? null : Number(externalRoutingCode)} onChange={(v) => onExternalRoutingCodeChange(v === null ? '' : String(v))} min={0} step={1} describedBy={describedBy('bp-routing-code', true, Boolean(routingCodeRefusal))} className="w-32" />
            </Field>
          </div>

          {/* A click buyer never reserves in the ledger, so its queue is the held clicks above. */}
          {!click && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700">Unresolved sales</h4>
              {unresolvedError ? (
                <p role="alert" className="text-xs text-red-700">{unresolvedError}</p>
              ) : unresolved === null ? (
                <p role="status" className="text-xs text-gray-500">Reading the unresolved sales…</p>
              ) : (
                <>
                  <UnresolvedSalesList rows={unresolved.rows} total={unresolved.total} onSettle={settle} outcomes={settleOutcomes} onMore={loadMoreUnresolved} loadingMore={loadingMore} />
                  {loadMoreError && <p role="alert" className="text-xs text-red-700">{loadMoreError}</p>}
                </>
              )}
            </div>
          )}

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">{SECTION_LABELS.blackout_dates}</h4>
            <LiveSectionNote sections={[SECTION_LABELS.blackout_dates]} />
            {blackoutNote && <p className="text-xs text-gray-500">{blackoutNote}</p>}
            <BlackoutDatesEditor value={profile.blackout_dates} onChange={(blackout_dates) => patch({ blackout_dates })} errors={byPath} />
          </div>
        </>
      )}
    </section>
  )
}
