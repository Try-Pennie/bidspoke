'use client'

/**
 * The Buyer profile section of the partner page (#1412, Phase 5 PR 2).
 *
 * The profile document and the accept rules are the partner form's state, so
 * one Save writes the partner record first (the rules live there) and the
 * profile second; this section renders the editors over that state and owns
 * the read surfaces beside them (usage, history, the unresolved queue) and the
 * one action that is its own: settling a sale.
 *
 * Ordered for the reader (L609): enabled and ranking first, pricing and caps
 * next, outcome rules, blackout dates last. Every fact once (L605): the scope
 * of the caps is said in the grid, the other sellers in the usage panel, the
 * priority direction on the priority field.
 */
import { useEffect, useState } from 'react'
import { PRIORITY_DIRECTION, type BuyerProfileDocument, type ProfileError, type Signal } from '@bidspoke/buyer-profile'
import type { SignalRules } from '@/app/(app)/partners/partner-body'
import { api } from '@/lib/api'
import { Field, NumberInput, Toggle, describedBy, type OutcomeState } from '@/components/ui/form'
import { SignalRuleBuilder, SIGNAL_SECTIONS } from '@/components/partners/SignalRuleBuilder'
import { AcceptRulesEditor } from './AcceptRulesEditor'
import { BlackoutDatesEditor } from './BlackoutDatesEditor'
import { BuyerProfileHistory, type HistoryEntry } from './BuyerProfileHistory'
import { BuyerUsagePanel, type BuyerUsage } from './BuyerUsagePanel'
import { CapsGrid, type CapsErrors } from './CapsGrid'
import { PricingTiersEditor } from './PricingTiersEditor'
import { ProfileConflictView } from './ProfileConflictView'
import { StatePicker } from './StatePicker'
import { UnresolvedSalesList, type SettleOutcome, type UnresolvedSale } from './UnresolvedSalesList'
import { WeeklyHoursEditor } from './WeeklyHoursEditor'
import { SECTION_LABELS } from './labels'

export const EMPTY_PROFILE: BuyerProfileDocument = {
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

export interface ProfileConflict {
  theirs: BuyerProfileDocument
  changedBy: string | null
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
  conflict: ProfileConflict | null
  onSaveOverTheirs: (theirVersion: number) => void
  onTakeTheirs: (theirs: BuyerProfileDocument) => void
}

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

export function BuyerProfileSection(props: Props) {
  const { partnerId, partnerName, profile, loadError, onProfileChange, errors, acceptSignals, onAcceptSignalsChange, duplicateSignals, onDuplicateSignalsChange, externalRoutingCode, onExternalRoutingCodeChange, signalRules, onSignalRulesChange, otherSellers, conflict, onSaveOverTheirs, onTakeTheirs } = props
  const [usage, setUsage] = useState<BuyerUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [unresolved, setUnresolved] = useState<{ rows: UnresolvedSale[]; total: number; page: number } | null>(null)
  const [unresolvedError, setUnresolvedError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** A failed Show more, kept apart from the first read's error so the rows already shown stay on screen with their controls. */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [settleOutcomes, setSettleOutcomes] = useState<Record<string, OutcomeState>>({})

  useEffect(() => {
    if (!partnerId) return
    let cancelled = false
    api.buyerProfiles.usage(partnerId).then((u) => { if (!cancelled) setUsage(u) }).catch((err: unknown) => { if (!cancelled) setUsageError(err instanceof Error ? err.message : 'The usage counts could not be read.') })
    api.buyerProfiles.history(partnerId).then((h) => { if (!cancelled) setHistory(h.entries) }).catch((err: unknown) => { if (!cancelled) setHistoryError(err instanceof Error ? err.message : 'The history could not be read.') })
    // This buyer's queue only, with the API's own total for it (#1457, L16): the
    // filter and the count come from one query, so "Showing N of M" is about the
    // rows the button can reach.
    api.buyerSales.list({ status: 'unresolved', page: 1, limit: UNRESOLVED_PAGE, partner_id: partnerId })
      .then((r) => {
        if (cancelled) return
        setUnresolved({ rows: r.entries.map((e) => toUnresolvedSale(e, partnerName)), total: r.total, page: 1 })
      })
      .catch((err: unknown) => { if (!cancelled) setUnresolvedError(err instanceof Error ? err.message : 'The unresolved sales could not be read.') })
    return () => { cancelled = true }
  }, [partnerId, partnerName])

  async function loadMoreUnresolved() {
    if (!partnerId || !unresolved || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const r = await api.buyerSales.list({ status: 'unresolved', page: unresolved.page + 1, limit: UNRESOLVED_PAGE, partner_id: partnerId })
      setUnresolved((u) => (u ? { rows: [...u.rows, ...r.entries.map((e) => toUnresolvedSale(e, partnerName))], total: r.total, page: u.page + 1 } : u))
    } catch (err) {
      setLoadMoreError(`The rest of the unresolved sales could not be read: ${err instanceof Error ? err.message : 'the read failed'}`)
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
      setSettleOutcomes((o) => ({ ...o, [id]: { kind: 'failed', message: err instanceof Error ? err.message : 'The settlement failed.' } }))
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
  const routingCodeRefusal = errorFor(errors, 'externalRoutingCode') ?? null

  return (
    <section aria-label="Buyer profile" className="space-y-6 rounded-lg border border-emerald-100 bg-emerald-50/30 p-4">
      <h3 className="text-xs font-semibold text-emerald-800">Buyer profile</h3>
      {!partnerId ? (
        <p className="text-sm text-gray-600">Save the partner first. The buyer profile is kept against the saved partner.</p>
      ) : loadError ? (
        <p role="alert" className="text-sm text-red-700">The buyer profile could not be read: {loadError}</p>
      ) : !profile ? (
        <p role="status" className="text-sm text-gray-600">Reading the buyer profile…</p>
      ) : (
        <>
          {conflict && <ProfileConflictView mine={profile} theirs={conflict.theirs} changedBy={conflict.changedBy} onSaveOverTheirs={onSaveOverTheirs} onTakeTheirs={onTakeTheirs} />}

          <div className="space-y-4">
            <h4 className="text-sm font-medium text-gray-700">Enabled and ranking</h4>
            <div className="flex items-center gap-3">
              <Toggle id="bp-enabled" checked={profile.is_enabled} onChange={(v) => patch({ is_enabled: v })} label="Enabled" />
              <label htmlFor="bp-enabled" className="text-sm text-graphite">Enabled</label>
              {errorFor(errors, 'isEnabled') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'isEnabled')}</p>}
            </div>
            <Field id="bp-priority" label="Priority" hint={PRIORITY_DIRECTION} error={errorFor(errors, 'priority')}>
              <NumberInput id="bp-priority" value={profile.priority} onChange={(v) => patch({ priority: v })} min={1} step={1} describedBy={describedBy('bp-priority', true, Boolean(errorFor(errors, 'priority')))} className="w-32" />
            </Field>
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
              <WeeklyHoursEditor value={profile.windows} onChange={(windows) => patch({ windows })} />
              {errorFor(errors, 'windows') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'windows')}</p>}
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">{SECTION_LABELS.tiers}</h4>
            <PricingTiersEditor value={profile.tiers} onChange={(tiers) => patch({ tiers })} errors={byPath} />
            {errorFor(errors, 'tiers') && <p role="alert" className="text-xs text-red-700">{errorFor(errors, 'tiers')}</p>}
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Caps</h4>
            <CapsGrid
              value={{ hourly_lead_cap: profile.hourly_lead_cap, daily_lead_cap: profile.daily_lead_cap, hourly_spend_cap_cents: profile.hourly_spend_cap_cents, daily_spend_cap_cents: profile.daily_spend_cap_cents }}
              onChange={(caps) => patch(caps)}
              errors={capErrors}
            />
            {usage === null && usageError === null ? (
              <p role="status" className="text-xs text-gray-500">Reading the usage counts…</p>
            ) : (
              <BuyerUsagePanel
                usage={usage}
                error={usageError}
                caps={{ hourly_lead_cap: profile.hourly_lead_cap, daily_lead_cap: profile.daily_lead_cap, hourly_spend_cap_cents: profile.hourly_spend_cap_cents, daily_spend_cap_cents: profile.daily_spend_cap_cents }}
                otherSellers={otherSellers}
                partnerName={partnerName}
              />
            )}
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Outcome rules</h4>
            <div>
              <p className="mb-1 text-sm font-medium text-gray-700">{SECTION_LABELS.accept_signals}</p>
              <p className="mb-2 text-xs text-gray-500">The buyer took the lead. A sale counts only when the answer is 2xx and every rule here matches.</p>
              <AcceptRulesEditor value={acceptSignals} onChange={onAcceptSignalsChange} refusal={acceptRefusal} />
            </div>
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

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">{SECTION_LABELS.blackout_dates}</h4>
            <BlackoutDatesEditor value={profile.blackout_dates} onChange={(blackout_dates) => patch({ blackout_dates })} errors={byPath} />
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium text-gray-700">History</h4>
            {historyError ? (
              <p role="alert" className="text-xs text-red-700">{historyError}</p>
            ) : history === null ? (
              <p role="status" className="text-xs text-gray-500">Reading the history…</p>
            ) : (
              <BuyerProfileHistory entries={history} />
            )}
          </div>
        </>
      )}
    </section>
  )
}
