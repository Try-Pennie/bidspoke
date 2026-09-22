'use client'

import { useState, useEffect, useRef } from 'react'
import type { Partner, PartnerBody, PartnerUuid, PartnerBidConfig, BidResolverType, BidMode, BidComparisonSource, ExtraExtractionConfig } from '@/lib/api'
import { PARTNER_TYPES, isBuyerPartner, isSourcePartner, partnerTypeLabel, type PartnerType } from '@/lib/partner-roles'
import {
  buildPartnerBody, parseList, listToString,
  type FormSnapshot, type SignalRules, type SubAccountFloor,
  type Rule, type BodyRule, type StatusRule, type BodyCondition, type StatusCondition, type SignalCategory,
} from './partner-body'
import { api } from '@/lib/api'
import { Save, Trash2, Loader2, Plus, Check, X } from 'lucide-react'
import { BidResolverEditor } from '@/components/partners/BidResolverEditor'
import { BidMatrixViewer } from '@/components/partners/BidMatrixViewer'
import { OutboundMappingEditor } from '@/components/partners/OutboundMappingEditor'
import { ExtraExtractionEditor } from '@/components/partners/ExtraExtractionEditor'
import { PartnerProbePanel } from '@/components/partners/PartnerProbePanel'
import { SignalRuleBuilder, SIGNAL_SECTIONS, parseRules } from '@/components/partners/SignalRuleBuilder'
import { BuyerProfileSection, EMPTY_PROFILE, type ProfileConflict } from '@/components/partners/buyer-profile/BuyerProfileSection'
import { Field as UiField, NumberInput, Outcome, describedBy, type OutcomeState } from '@/components/ui/form'
import { documentToProfile, validateProfile, type BuyerProfileDocument, type ProfileError, type Signal } from '@bidspoke/buyer-profile'
import { UNSAVED_CHANGES_MESSAGE } from '@/lib/save-dirty-guard'

// Re-exported for the parent page's partner-switch / New guards, and the
// canvas's own away-click guard (#478), so the prompt copy stays identical.
export { UNSAVED_CHANGES_MESSAGE }

// ── Sub account floors ─────────────────────────────────────────────────────────

function floorsFromMap(map: Record<string, number> | null | undefined): SubAccountFloor[] {
  if (!map) return []
  return Object.entries(map).map(([uuid, bid]) => ({ id: uid(), uuid, bid: String(bid) }))
}

function uid() { return Math.random().toString(36).slice(2) }

// ── Form field primitives ─────────────────────────────────────────────────────

interface Props {
  partner?: Partner
  onSave: (body: PartnerBody, id?: string, pendingUuids?: string[]) => Promise<void>
  onCancel: () => void
  onDelete?: (id: string) => void
  confirmingDelete?: boolean
  onConfirmDelete?: () => void
  onCancelDelete?: () => void
  deleting?: boolean
  /** Reports whether the form has unsaved edits, so the parent can guard partner-switch / New. */
  onDirtyChange?: (dirty: boolean) => void
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text', mono }: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark ${mono ? 'font-mono' : ''}`}
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark focus-visible:ring-offset-1 ${checked ? 'bg-p-blue-dark' : 'bg-gray-200'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-4 text-xs font-semibold text-gray-500">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

// ── Main form ─────────────────────────────────────────────────────────────────

type SaveState = 'idle' | 'saving' | 'saved'

export default function PartnerForm({
  partner,
  onSave,
  onCancel,
  onDelete,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  deleting,
  onDirtyChange,
}: Props) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [undoSnapshot, setUndoSnapshot] = useState<FormSnapshot | null>(null)
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0)

  const [name, setName] = useState(partner?.name ?? '')
  const [slug, setSlug] = useState(partner?.slug ?? '')
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)

  function handleNameChange(value: string) {
    setName(value)
    if (!slugManuallyEdited) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    }
  }
  const [apiEndpoint, setApiEndpoint] = useState(partner?.api_endpoint ?? '')
  const [cfSecretKey, setCfSecretKey] = useState(partner?.cf_secret_key ?? '')
  const [clickUrl, setClickUrl] = useState(partner?.click_url ?? '')
  const [isActive, setIsActive] = useState(partner?.is_active ?? true)
  const [priority, setPriority] = useState(String(partner?.priority ?? 0))

  const [dailyCap, setDailyCap] = useState(partner?.daily_cap != null ? String(partner.daily_cap) : '')
  const [minBid, setMinBid] = useState(partner?.min_bid != null ? String(partner.min_bid) : '')
  const [bidFormula, setBidFormula] = useState(partner?.bid_formula ?? '')
  const [resolverType, setResolverType] = useState<BidResolverType>(partner?.bid_resolver_type ?? 'api')
  const [resolverConfig, setResolverConfig] = useState<Record<string, unknown>>(partner?.bid_resolver_config ?? {})
  const [outboundMapping, setOutboundMapping] = useState<Record<string, unknown> | null>(partner?.outbound_field_mapping ?? null)
  const [bidMode, setBidMode] = useState<BidMode>(partner?.bid_mode ?? 'commit')
  const [bidComparisonSource, setBidComparisonSource] = useState<BidComparisonSource>(partner?.bid_comparison_source ?? 'auto')
  const [extraExtraction, setExtraExtraction] = useState<ExtraExtractionConfig | null>(partner?.extra_extraction ?? null)
  const [lastProbeResponse, setLastProbeResponse] = useState<unknown>(partner?.last_probe_response ?? null)
  const [bidConfigs, setBidConfigs] = useState<PartnerBidConfig[]>([])
  const [dedupEndpoint, setDedupEndpoint] = useState(partner?.dedup_endpoint ?? '')

  const [circuitEnabled, setCircuitEnabled] = useState(partner?.circuit_enabled ?? true)
  const [circuitThreshold, setCircuitThreshold] = useState(String(partner?.circuit_error_threshold ?? 5))
  const [circuitWindow, setCircuitWindow] = useState(String(partner?.circuit_window_seconds ?? 60))
  const [circuitCooldown, setCircuitCooldown] = useState(String(partner?.circuit_cooldown_seconds ?? 300))

  const [confirmationWindowMs, setConfirmationWindowMs] = useState(
    partner?.confirmation_window_ms != null ? String(partner.confirmation_window_ms) : ''
  )

  const [signalRules, setSignalRules] = useState<SignalRules>(() => parseRules(partner?.response_classification))
  // The buyer profile (#1412): the accept rules live on the partner record and
  // save with it; the document lives in buyer_profiles and saves second, through
  // its own versioned route. Both are form state so one Save covers the page.
  const [acceptSignals, setAcceptSignals] = useState<Signal[]>(() => (Array.isArray(partner?.accept_signals) ? (partner.accept_signals as Signal[]) : []))
  const [profile, setProfile] = useState<BuyerProfileDocument | null>(null)
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [otherSellers, setOtherSellers] = useState<Array<{ id: string; name: string }>>([])
  const [profileErrors, setProfileErrors] = useState<ProfileError[]>([])
  const [conflict, setConflict] = useState<ProfileConflict | null>(null)
  const [saveOutcome, setSaveOutcome] = useState<OutcomeState>({ kind: 'idle' })
  // What the profile looked like when it loaded or was last saved, so an edit to
  // it counts as dirty and a load does not.
  const profileBaseline = useRef<string | null>(null)

  const defaultAlertConfig = partner?.alert_config as { transient_errors?: { alert?: boolean }; permanent_errors?: { alert?: boolean } } | null | undefined
  const [alertTransient, setAlertTransient] = useState(defaultAlertConfig?.transient_errors?.alert !== false)
  const [alertPermanent, setAlertPermanent] = useState(defaultAlertConfig?.permanent_errors?.alert !== false)

  const [partnerType, setPartnerType] = useState<PartnerType>(partner?.partner_type ?? 'buyer')

  const [sellOffOfferTitle, setSellOffOfferTitle] = useState(partner?.sell_off_offer_title ?? '')
  const [sellOffOfferDetails, setSellOffOfferDetails] = useState(partner?.sell_off_offer_details ?? '')
  const [subAccountFloors, setSubAccountFloors] = useState<SubAccountFloor[]>(() => floorsFromMap(partner?.sub_account_min_bids))

  const [uuids, setUuids] = useState<PartnerUuid[]>([])
  const [pendingUuids, setPendingUuids] = useState<string[]>([])
  const [newUuid, setNewUuid] = useState('')
  const [addingUuid, setAddingUuid] = useState(false)
  const [uuidError, setUuidError] = useState<string | null>(null)
  const [removingUuidId, setRemovingUuidId] = useState<string | null>(null)

  useEffect(() => {
    if (!partner) return
    api.partnerUuids.list()
      .then((all) => setUuids(all.filter((u) => u.partner_slug === partner.slug)))
      .catch(() => {})
    api.partnerBidConfigs.list(partner.id)
      .then(setBidConfigs)
      .catch(() => {})
  }, [partner])

  // The buyer profile is read once the partner is known to be a buyer. A read
  // that fails is its own state on the section, never an empty profile (L10).
  useEffect(() => {
    if (!partner || !isBuyerPartner(partnerType) || profile !== null || profileLoadError !== null) return
    let cancelled = false
    api.buyerProfiles.get(partner.id)
      .then((r) => {
        if (cancelled) return
        const loaded = r.profile ?? { ...EMPTY_PROFILE, partner_id: partner.id, version: 0 }
        profileBaseline.current = JSON.stringify(loaded)
        setProfile(loaded)
        setOtherSellers(r.other_sellers)
      })
      .catch((err: unknown) => { if (!cancelled) setProfileLoadError(err instanceof Error ? err.message : 'unknown error') })
    return () => { cancelled = true }
  }, [partner, partnerType, profile, profileLoadError])

  // Undo countdown
  useEffect(() => {
    if (undoSecondsLeft <= 0) return
    const t = setTimeout(() => {
      setUndoSecondsLeft((s) => {
        if (s <= 1) { setUndoSnapshot(null); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearTimeout(t)
  }, [undoSecondsLeft])

  function captureSnapshot(): FormSnapshot {
    return { name, apiEndpoint, cfSecretKey, clickUrl, isActive, priority, dailyCap, minBid, bidFormula, resolverType, resolverConfig, outboundMapping, bidMode, bidComparisonSource, extraExtraction, lastProbeResponse, dedupEndpoint, circuitEnabled, circuitThreshold, circuitWindow, circuitCooldown, signalRules, alertTransient, alertPermanent, sellOffOfferTitle, sellOffOfferDetails, partnerType, confirmationWindowMs, subAccountFloors, acceptSignals }
  }

  // Dirty tracking — compare current values against the values at mount (reset
  // after each successful save). This is a real-money config surface, so silently
  // losing an edit (e.g. a flipped Status toggle that was never saved) is high-impact.
  const dirtyKey = JSON.stringify({ ...captureSnapshot(), slug })
  const baselineDirtyKey = useRef<string | null>(null)
  if (baselineDirtyKey.current === null) baselineDirtyKey.current = dirtyKey
  const profileDirty = profile !== null && profileBaseline.current !== null && JSON.stringify(profile) !== profileBaseline.current
  const dirty = baselineDirtyKey.current !== dirtyKey || profileDirty
  // The restorable pre-edit baseline (values at mount / after the last save). Undo
  // re-saves THIS, not the values that were just saved (#98).
  const baselineSnapshot = useRef<FormSnapshot | null>(null)
  if (baselineSnapshot.current === null) baselineSnapshot.current = captureSnapshot()

  // Tell the parent so it can guard partner-switch / New (those are <button>s the
  // link interceptor below can't see).
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  // Warn on tab close / refresh / external navigation while dirty.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Intercept client-side <a> navigations (left nav, etc.) while dirty. The
  // partner list / Cancel / New are <button>s handled by the parent + Cancel guards.
  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as HTMLElement | null)?.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || anchor.target === '_blank') return
      if (!window.confirm(UNSAVED_CHANGES_MESSAGE)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty])

  function restoreSnapshot(snap: FormSnapshot) {
    setName(snap.name); setApiEndpoint(snap.apiEndpoint); setCfSecretKey(snap.cfSecretKey)
    setClickUrl(snap.clickUrl); setIsActive(snap.isActive); setPriority(snap.priority)
    setDailyCap(snap.dailyCap); setMinBid(snap.minBid); setBidFormula(snap.bidFormula)
    setResolverType(snap.resolverType); setResolverConfig(snap.resolverConfig)
    setOutboundMapping(snap.outboundMapping)
    setBidMode(snap.bidMode); setBidComparisonSource(snap.bidComparisonSource)
    setExtraExtraction(snap.extraExtraction); setLastProbeResponse(snap.lastProbeResponse)
    setDedupEndpoint(snap.dedupEndpoint); setCircuitEnabled(snap.circuitEnabled)
    setCircuitThreshold(snap.circuitThreshold); setCircuitWindow(snap.circuitWindow)
    setCircuitCooldown(snap.circuitCooldown); setSignalRules(snap.signalRules)
    setAlertTransient(snap.alertTransient); setAlertPermanent(snap.alertPermanent)
    setSellOffOfferTitle(snap.sellOffOfferTitle); setSellOffOfferDetails(snap.sellOffOfferDetails)
    setPartnerType(snap.partnerType); setConfirmationWindowMs(snap.confirmationWindowMs)
    setSubAccountFloors(snap.subAccountFloors)
    setAcceptSignals(snap.acceptSignals as Signal[])
  }

  async function handleUndo() {
    if (!undoSnapshot) return
    const snap = undoSnapshot
    setUndoSnapshot(null)
    setUndoSecondsLeft(0)
    restoreSnapshot(snap)
    setError(null)
    setSaveState('saving')
    try {
      // Re-save the pre-edit values so the revert reaches the server, not just the
      // form — without this the Undo button looked like it worked but the DB kept
      // the just-saved change (#98).
      await onSave(buildPartnerBody(snap, { slug, isExisting: !!partner }), partner?.id, undefined)
      baselineDirtyKey.current = JSON.stringify({ ...snap, slug })
      baselineSnapshot.current = snap
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to undo')
      setSaveState('idle')
    }
  }

  /**
   * Save the buyer profile document through its versioned route (#1412). A
   * stale version comes back as the side by side; the person's edits stay in
   * the form whichever way they resolve it (L717).
   */
  async function saveProfile(expectedVersion: number): Promise<'saved' | 'conflict' | 'failed'> {
    if (!partner || !profile) return 'saved'
    try {
      const saved = await api.buyerProfiles.save(partner.id, { expected_version: expectedVersion, profile })
      profileBaseline.current = JSON.stringify(saved.profile)
      setProfile(saved.profile)
      setConflict(null)
      setSaveOutcome({ kind: 'done', message: `Partner saved. Buyer profile saved, version ${saved.profile.version ?? '?'}.` })
      return 'saved'
    } catch (err) {
      const e = err as Error & { status?: number; body?: { error?: string; current?: BuyerProfileDocument } }
      if (e.status === 409 && e.body?.current) {
        setConflict({ theirs: e.body.current, changedBy: null })
        setSaveOutcome({ kind: 'failed', message: 'Partner saved. The buyer profile was not saved: it changed underneath you. Compare below.' })
        return 'conflict'
      }
      setSaveOutcome({ kind: 'failed', message: `Partner saved. The buyer profile was not saved: ${e.message}` })
      return 'failed'
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setProfileErrors([])
    const snapshot = captureSnapshot()
    // Capture the pre-edit baseline BEFORE we advance it — this is what Undo restores.
    const preEdit = baselineSnapshot.current

    // The buyer profile is validated with the shared package before ANY write, so
    // a refused profile leaves the partner record untouched too, and the errors
    // land beside the controls they name (L608).
    const buyer = isBuyerPartner(partnerType)
    if (buyer && profile) {
      const validation = validateProfile(documentToProfile({ ...profile, partner_id: partner?.id ?? '' }), { acceptSignals })
      if (!validation.ok) {
        setProfileErrors(validation.errors)
        setSaveOutcome({ kind: 'failed', message: `Nothing saved. Fix the buyer profile first: ${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'} marked below.` })
        return
      }
    }

    setSaveState('saving')
    setSaveOutcome({ kind: 'working', label: 'Saving the partner', startedAt: Date.now(), now: Date.now(), stalledAfterMs: 30_000 })
    try {
      await onSave(buildPartnerBody(snapshot, { slug, isExisting: !!partner }), partner?.id, isNew ? pendingUuids : undefined)
      // The saved values are now the clean baseline — clears the dirty flag.
      baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
      baselineSnapshot.current = snapshot
      setSaveState('saved')
      // Offer Undo for an existing partner: restore + re-save the PRE-edit values.
      // Undo covers the partner record; the profile keeps its own version history.
      if (!isNew && preEdit) {
        setUndoSnapshot(preEdit)
        setUndoSecondsLeft(5)
      }
      setTimeout(() => setSaveState('idle'), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save partner')
      setSaveOutcome({ kind: 'failed', message: `Nothing saved: ${err instanceof Error ? err.message : 'the partner save failed'}` })
      setSaveState('idle')
      return
    }

    if (buyer && partner && profile && profileDirty) {
      setSaveOutcome({ kind: 'working', label: 'Saving the buyer profile', startedAt: Date.now(), now: Date.now(), stalledAfterMs: 30_000 })
      await saveProfile(profile.version ?? 0)
    } else {
      setSaveOutcome({ kind: 'done', message: 'Partner saved.' })
    }
  }

  const isNew = !partner

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          {isNew
            ? <h2 className="text-lg font-medium text-gray-500">New partner</h2>
            : <h2 className="text-2xl font-bold text-graphite">{name || <span className="text-gray-300">Unnamed</span>}</h2>
          }
          {!isNew && (
            <p className="mt-0.5 font-mono text-sm text-gray-500">{partner.slug}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && onDelete && (
            confirmingDelete ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onConfirmDelete}
                  disabled={deleting}
                  className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  onClick={onCancelDelete}
                  className="text-sm text-gray-500 hover:text-gray-600"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onDelete(partner.id)}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => { if (dirty && !window.confirm(UNSAVED_CHANGES_MESSAGE)) return; onCancel() }}
            className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
          >
            Cancel
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/*
        #416. Deliberately NOT the error banner above: an error means the save did
        not happen, and a partner whose credential is unprovisioned saved fine.
        Amber, and its own role="status", so it reads as a standing condition
        rather than as a failed action.
      */}
      {partner?.credential_warning && (
        <div role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {partner.credential_warning}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">

        <Section title="Identity">
          <Field label="Name" hint="Display name shown in the UI.">
            <Input value={name} onChange={handleNameChange} placeholder="Tripoint" />
          </Field>
          {isNew && (
            <Field
              label="Slug"
              hint="Lowercase identifier used in logs and workflow references. Cannot be changed after creation."
            >
              <Input
                value={slug}
                onChange={(v) => { setSlug(v); setSlugManuallyEdited(true) }}
                placeholder="tripoint"
                mono
              />
            </Field>
          )}
          <Field label="Type" hint="Source partners send leads to Pennie. Buyer partners receive bids. Both does each, on one record.">
            <div className="mt-1 inline-flex rounded-lg border border-gray-200 p-0.5">
              {PARTNER_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPartnerType(t)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-100 ${
                    partnerType === t
                      ? 'bg-p-blue-dark text-white'
                      : 'text-gray-500 hover:text-graphite'
                  }`}
                >
                  {partnerTypeLabel(t)}
                </button>
              ))}
            </div>
          </Field>
          <div className="flex items-center gap-6">
            {/* Relabelled from Priority (#1412, L118): the buyer profile's priority is
                who is offered a lead first; this field only orders the partner list. */}
            {isBuyerPartner(partnerType) && (
              <UiField id="partner-list-order" label="List order" hint="Orders the partner list. It does not affect who is offered a lead.">
                <NumberInput id="partner-list-order" value={priority === '' ? null : Number(priority)} onChange={(v) => setPriority(v === null ? '' : String(v))} step={1} describedBy={describedBy('partner-list-order', true, false)} />
              </UiField>
            )}
            <Field label="Status">
              <div className="flex items-center gap-2.5 pt-1">
                <Toggle checked={isActive} onChange={setIsActive} label="Partner active" />
                <span className="text-sm text-gray-700">{isActive ? 'Active' : 'Inactive'}</span>
              </div>
            </Field>
          </div>
        </Section>

        {isBuyerPartner(partnerType) && (
          <BuyerProfileSection
            partnerId={partner?.id ?? null}
            partnerName={name || partner?.name || 'this buyer'}
            profile={profile}
            loadError={profileLoadError}
            onProfileChange={setProfile}
            errors={profileErrors}
            acceptSignals={acceptSignals}
            onAcceptSignalsChange={setAcceptSignals}
            signalRules={signalRules}
            onSignalRulesChange={setSignalRules}
            otherSellers={otherSellers}
            conflict={conflict}
            onSaveOverTheirs={(theirVersion) => { void saveProfile(theirVersion) }}
            onTakeTheirs={(theirs) => { profileBaseline.current = JSON.stringify(theirs); setProfile(theirs); setConflict(null); setSaveOutcome({ kind: 'done', message: 'Took the saved profile. Your edits to it were replaced.' }) }}
          />
        )}
        {isBuyerPartner(partnerType) && <Section title="Bid resolution">
          <BidResolverEditor
            resolverType={resolverType}
            resolverConfig={resolverConfig}
            bidFormula={bidFormula}
            apiEndpoint={apiEndpoint}
            cfSecretKey={cfSecretKey}
            bidComparisonSource={bidComparisonSource}
            bidConfigOptions={bidConfigs.map((c) => ({ id: c.id, name: c.name, slug: c.slug }))}
            onTypeChange={setResolverType}
            onFormulaChange={setBidFormula}
            onApiEndpointChange={setApiEndpoint}
            onCfSecretKeyChange={setCfSecretKey}
            onBidComparisonSourceChange={setBidComparisonSource}
            onConfigChange={setResolverConfig}
          />
          {resolverType === 'matrix' && partner && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <h4 className="mb-2 text-sm font-medium text-graphite">Matrix</h4>
              <BidMatrixViewer
                partnerId={partner.id}
                partnerSlug={partner.slug}
                configs={bidConfigs}
                onConfigsChange={setBidConfigs}
                selectedConfigId={typeof resolverConfig.bid_config_id === 'string' ? resolverConfig.bid_config_id : undefined}
                onSelectConfig={(id) => setResolverConfig({ ...resolverConfig, bid_config_id: id })}
              />
            </div>
          )}
          {resolverType === 'matrix' && !partner && (
            <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-sm text-gray-500">
              Save the partner first to attach a bid matrix.
            </p>
          )}
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Endpoints">
          <Field
            label="Click URL"
            hint="Landing page URL for leads routed to this partner. Exposed as {Slug}ClickUrl in the Constants node."
          >
            <Input value={clickUrl} onChange={setClickUrl} placeholder="https://partner.com/apply" />
          </Field>
          <Field
            label="Dedup endpoint"
            hint="Optional. Called before each bid to check if this lead has already been sold to this partner."
          >
            <Input value={dedupEndpoint} onChange={setDedupEndpoint} placeholder="https://api.partner.com/dedup" />
          </Field>
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Outbound field mapping">
          <OutboundMappingEditor value={outboundMapping} onChange={setOutboundMapping} />
        </Section>}

        {isBuyerPartner(partnerType) && resolverType === 'api' && <Section title="Response handling">
          <Field label="Bid mode" hint="commit: the API call creates a lead. ping_only: the call is a lightweight bid quote with no side effects.">
            <div className="mt-1 inline-flex rounded-lg border border-gray-200 p-0.5">
              {(['commit', 'ping_only'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setBidMode(m)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-100 ${
                    bidMode === m ? 'bg-p-blue-dark text-white' : 'text-gray-500 hover:text-graphite'
                  }`}
                >
                  {m === 'commit' ? 'Commit' : 'Ping only'}
                </button>
              ))}
            </div>
          </Field>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-2 text-sm font-medium text-graphite">Sample response</h4>
            <PartnerProbePanel value={lastProbeResponse} onChange={setLastProbeResponse} />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-2 text-sm font-medium text-graphite">Extra extraction</h4>
            <ExtraExtractionEditor
              value={extraExtraction}
              onChange={setExtraExtraction}
              sampleResponse={lastProbeResponse}
            />
          </div>
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Bidding limits">
          <div className="grid grid-cols-2 gap-4">
            {/* Relabelled from Daily cap (#1412, L118): the buyer profile has its own
                daily lead cap for buyer selection; this one bounds Partner Bid attempts. */}
            <UiField id="partner-daily-attempt-cap" label="Daily attempt cap (bidding workflows)" hint="Max bid attempts per day through Partner Bid and Bid Group. Leave blank for unlimited.">
              <NumberInput id="partner-daily-attempt-cap" value={dailyCap === '' ? null : Number(dailyCap)} onChange={(v) => setDailyCap(v === null ? '' : String(v))} min={0} step={1} describedBy={describedBy('partner-daily-attempt-cap', true, false)} />
            </UiField>
            <Field label="Minimum bid ($)" hint="Reject bids below this amount. Leave blank to accept any bid down to $0. Set a positive amount (e.g. 0.01) to treat a $0 bid as a decline.">
              <Input value={minBid} onChange={setMinBid} type="number" placeholder="0.00" />
            </Field>
          </div>
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Per-sub-account min bids">
          <p className="text-xs text-gray-500">
            Optional per-sub-account floor. When a lead arrives with a matching sub-account UUID,
            this floor overrides the partner-wide Minimum bid. Leave empty to use only the partner-wide floor.
          </p>
          <div className="space-y-1.5">
            {subAccountFloors.map((f, i) => (
              <div key={f.id} className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                <input
                  value={f.uuid}
                  onChange={(e) => setSubAccountFloors((prev) => prev.map((row, j) => j === i ? { ...row, uuid: e.target.value } : row))}
                  placeholder="sub-account UUID"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
                />
                <input
                  value={f.bid}
                  onChange={(e) => setSubAccountFloors((prev) => prev.map((row, j) => j === i ? { ...row, bid: e.target.value } : row))}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
                />
                <button
                  type="button"
                  onClick={() => setSubAccountFloors((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-600"
                  aria-label="Remove row"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setSubAccountFloors((prev) => [...prev, { id: uid(), uuid: '', bid: '' }])}
              className="flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:border-gray-400 hover:text-graphite"
            >
              <Plus size={12} /> Add row
            </button>
          </div>
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Circuit breaker">
          <div className="flex items-center gap-2.5">
            <Toggle checked={circuitEnabled} onChange={setCircuitEnabled} label="Circuit breaker enabled" />
            <span className="text-sm text-gray-700">{circuitEnabled ? 'Enabled' : 'Disabled'}</span>
            <span className="text-gray-300">·</span>
            <p className="text-xs text-gray-500">
              Pauses bids to this partner after repeated failures, then retries automatically.
            </p>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${circuitEnabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="grid grid-cols-3 gap-4 pt-1">
                <Field label="Error threshold" hint="Errors before pausing.">
                  <Input value={circuitThreshold} onChange={setCircuitThreshold} type="number" placeholder="5" />
                </Field>
                <Field label="Window (seconds)" hint="Time period to count errors in.">
                  <Input value={circuitWindow} onChange={setCircuitWindow} type="number" placeholder="60" />
                </Field>
                <Field label="Pause duration (seconds)" hint="How long to wait before retrying.">
                  <Input value={circuitCooldown} onChange={setCircuitCooldown} type="number" placeholder="300" />
                </Field>
              </div>
            </div>
          </div>
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Response classification">
          <p className="text-xs text-gray-500">
            Override how this partner&apos;s responses are classified. Rules are evaluated before the defaults.
            Leave all sections empty to use default HTTP status–based classification.
          </p>
          {/* The decline group (rejection) is edited in the Buyer profile section beside
              the accept rules, so it is not repeated here (#1412, L605). */}
          <SignalRuleBuilder value={signalRules} onChange={setSignalRules} sections={SIGNAL_SECTIONS.filter((s) => s.cat !== 'rejection')} />
        </Section>}

        <Section title="Bid confirmation latency">
          <p className="text-xs text-gray-500">
            Used by the Latency Gate node. Maximum acceptable time between our bid and this partner&apos;s
            Bid Win Confirmation. Confirmations slower than this are rejected (reject due to latency). Leave
            blank to require a node-level override instead.
          </p>
          <Field label="Confirmation window (ms)" hint="e.g. 5000 = 5 seconds.">
            <Input value={confirmationWindowMs} onChange={setConfirmationWindowMs} type="number" placeholder="(none)" />
          </Field>
        </Section>

        {isSourcePartner(partnerType) && <Section title="Sell-off offer copy">
          <p className="text-xs text-gray-500">
            Used by the Constants node in bidding workflows to populate sell-off offer fields for this partner.
          </p>
          <Field label="Sell-off offer title">
            <Input value={sellOffOfferTitle} onChange={setSellOffOfferTitle} placeholder="Get up to $50,000 in your account" />
          </Field>
          <Field label="Sell-off offer details">
            <textarea
              value={sellOffOfferDetails}
              onChange={(e) => setSellOffOfferDetails(e.target.value)}
              placeholder="Personal loans from $5,000–$100,000 with competitive rates."
              rows={3}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
            />
          </Field>
        </Section>}

        {isSourcePartner(partnerType) && <Section title="Sub-account UUIDs">
          <p className="text-xs text-gray-500">
            External UUIDs that map to this partner. Used by the Constants node to resolve inbound sub-account IDs to partner slugs.
          </p>
          <div className="space-y-1.5">
            {isNew ? (
              pendingUuids.map((uuid, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <span className="flex-1 truncate font-mono text-xs text-graphite">{uuid}</span>
                  <button
                    type="button"
                    onClick={() => setPendingUuids((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Remove UUID"
                    className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            ) : (
              uuids.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <span className="flex-1 truncate font-mono text-xs text-graphite">{u.uuid}</span>
                  <button
                    type="button"
                    aria-label="Remove UUID"
                    disabled={removingUuidId === u.id}
                    onClick={async () => {
                      setRemovingUuidId(u.id)
                      setUuidError(null)
                      try {
                        await api.partnerUuids.delete(u.id)
                        setUuids((prev) => prev.filter((x) => x.id !== u.id))
                      } catch (err) {
                        setUuidError(err instanceof Error ? err.message : 'Failed to remove UUID')
                      } finally {
                        setRemovingUuidId(null)
                      }
                    }}
                    className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-600 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={newUuid}
              onChange={(e) => { setNewUuid(e.target.value); setUuidError(null) }}
              placeholder="Enter UUID"
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
            />
            <button
              type="button"
              disabled={!newUuid.trim() || addingUuid}
              onClick={async () => {
                if (!newUuid.trim()) return
                if (isNew) {
                  setPendingUuids((prev) => [...prev, newUuid.trim()])
                  setNewUuid('')
                  return
                }
                if (!partner) return
                setAddingUuid(true)
                setUuidError(null)
                try {
                  const created = await api.partnerUuids.create({ partner_slug: partner.slug, uuid: newUuid.trim() })
                  setUuids((prev) => [...prev, created])
                  setNewUuid('')
                } catch (err) {
                  setUuidError(err instanceof Error ? err.message : 'Failed to add UUID')
                } finally {
                  setAddingUuid(false)
                }
              }}
              className="flex items-center gap-1.5 rounded-lg bg-p-blue-dark px-3 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
            >
              {addingUuid ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </div>
          {uuidError && <p className="text-xs text-red-600">{uuidError}</p>}
        </Section>}

        {isBuyerPartner(partnerType) && <Section title="Alert configuration">
          <p className="text-xs text-gray-500">
            Default: alert on all errors. Turn off alert types that produce noise for this partner.
            Business rejections never alert regardless.
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">Transient error alerts</p>
                <p className="text-xs text-gray-500">Network failures, timeouts, 429, 502–504</p>
              </div>
              <Toggle checked={alertTransient} onChange={setAlertTransient} label="Transient error alerts" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">Permanent error alerts</p>
                <p className="text-xs text-gray-500">4xx errors, auth failures, bad responses</p>
              </div>
              <Toggle checked={alertPermanent} onChange={setAlertPermanent} label="Permanent error alerts" />
            </div>
          </div>
        </Section>}

        <div className="flex items-center gap-3 border-t border-gray-100 pt-6">
          <button
            type="submit"
            disabled={saveState === 'saving' || !name}
            className={`flex min-w-[130px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors duration-150 disabled:opacity-50 ${
              saveState === 'saved' ? 'bg-green-600 hover:bg-green-700' : 'bg-p-blue-dark hover:bg-[#155E99]'
            }`}
          >
            {saveState === 'saving' && <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>}
            {saveState === 'saved'  && <><Check  className="h-4 w-4" /> Saved</>}
            {saveState === 'idle'   && <><Save   className="h-4 w-4" /> {isNew ? 'Create partner' : 'Save changes'}</>}
          </button>
          <Outcome state={saveOutcome} />
          {undoSnapshot && (
            <button
              type="button"
              onClick={handleUndo}
              className="text-xs text-gray-500 transition-colors hover:text-gray-700"
            >
              Undo · {undoSecondsLeft}s
            </button>
          )}
          {dirty && saveState !== 'saving' && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Unsaved changes
            </span>
          )}
          {!isNew && !undoSnapshot && !dirty && (
            <p className="text-xs text-gray-500">
              {`Modified ${new Date(partner.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} by ${partner.updated_by_name ?? partner.updated_by_email?.split('@')[0] ?? 'unknown'}`}
            </p>
          )}
        </div>

      </form>
    </div>
  )
}
