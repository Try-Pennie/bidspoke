'use client'

import { useState, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Partner, PartnerBody, PartnerUuid, PartnerBidConfig, BidResolverType, BidComparisonSource, ExtraExtractionConfig, PartnerPageSaveRequest, PartnerPageStale } from '@/lib/api'
import { PARTNER_TYPES, isBuyerPartner, isSourcePartner, partnerTypeLabel, type PartnerType } from '@/lib/partner-roles'
import {
  buildPartnerBody, changedPatch, draftReducer, initDraft, inversePatch, parseList, listToString, parseRoutingCode, snapshotOf, PARTNER_FIELD_REGISTRY,
  type FormSnapshot, type SignalRules, type SubAccountFloor,
  type Rule, type BodyRule, type StatusRule, type BodyCondition, type StatusCondition, type SignalCategory,
} from './partner-draft'
import { formatEtDayTime } from '@/lib/dates'
import { pickupSentence } from '@/lib/bidding-pickup'
import { api } from '@/lib/api'
import { errorSentence } from '@/lib/error-sentence'
import { Save, Trash2, Loader2, Plus, Check, X } from 'lucide-react'
import { BidResolverEditor } from '@/components/partners/BidResolverEditor'
import { BidMatrixViewer } from '@/components/partners/BidMatrixViewer'
import { OutboundMappingEditor } from '@/components/partners/OutboundMappingEditor'
import { ExtraExtractionEditor } from '@/components/partners/ExtraExtractionEditor'
import { PartnerProbePanel } from '@/components/partners/PartnerProbePanel'
import { SignalRuleBuilder, SIGNAL_SECTIONS } from '@/components/partners/SignalRuleBuilder'
import { BuyerProfileSection, EMPTY_PROFILE } from '@/components/partners/buyer-profile/BuyerProfileSection'
import { MergeDialog } from '@/components/partners/MergeDialog'
import { mergeThreeWay, sameMergeValue, type MergeResult, type MergeSide, type PageHalves } from '@/lib/partner-page-merge'
import { describeProfileErrors } from '@/components/partners/buyer-profile/labels'
import { clickDeliveryConsequences } from '@/components/partners/buyer-profile/click-delivery-consequences'
import { Button as UiButton, Field as UiField, NumberInput, Outcome, describedBy, type OutcomeState } from '@/components/ui/form'
import { documentToProfile, soldOnSwitchBlocked, validateProfile, type BuyerProfileDocument, type ProfileError, type Signal, type StoredKind } from '@bidspoke/buyer-profile'
import { UNSAVED_CHANGES_MESSAGE } from '@/lib/save-dirty-guard'

// Re-exported for the parent page's partner-switch / New guards, so the prompt
// copy stays identical until PR7 (#2138) replaces all three with a dialog.
export { UNSAVED_CHANGES_MESSAGE }

function uid() { return Math.random().toString(36).slice(2) }

// ── Form field primitives ─────────────────────────────────────────────────────

/**
 * What the page hands back for a saved partner (#2132, #2133): the row and the
 * buyer profile as stored after the save, and the stored copy warning when
 * there was one.
 */
export interface PartnerSaveResult {
  partner: Partner
  profile: BuyerProfileDocument | null
  copyWarning: string | null
}

/**
 * The sentence for a save refused because someone else saved first (#2132).
 * It names who and when (in ET, through dates.ts), or says the change came from
 * outside the page when no editor is on record. The edits are kept.
 */
export function staleSaveSentence(stale: Pick<PartnerPageStale, 'changed_by_name' | 'changed_at'>): string {
  const when = stale.changed_at ? `${formatEtDayTime(stale.changed_at)} ET` : 'an unknown time'
  return stale.changed_by_name
    ? `Not saved. ${stale.changed_by_name} saved this partner at ${when}. Your changes are still here.`
    : `Not saved. This partner was changed at ${when}, outside the partners page. Your changes are still here.`
}

/** The same refusal for an Undo, which has no edits of its own to keep: the form still shows what is stored. */
export function staleUndoSentence(stale: Pick<PartnerPageStale, 'changed_by_name' | 'changed_at'>): string {
  const when = stale.changed_at ? `${formatEtDayTime(stale.changed_at)} ET` : 'an unknown time'
  return stale.changed_by_name
    ? `Undo not made. ${stale.changed_by_name} saved this partner at ${when}.`
    : `Undo not made. This partner was changed at ${when}, outside the partners page.`
}

/** The id of one press of Save (#2132), reused only by a retry of that press. */
function mintSaveId(): string {
  return crypto.randomUUID()
}

interface Props {
  partner?: Partner
  /**
   * Saves the partner. An existing partner's save is the whole page in one
   * request (#2133): the body is only the changed partner fields (#2132), and
   * the request carries the profile when it changed, the pair of versions the
   * page was edited from, and this press's save id. Answers both halves as
   * stored and any stored copy warning.
   */
  onSave: (body: PartnerBody, id?: string, pendingUuids?: string[], request?: PartnerPageSaveRequest) => Promise<PartnerSaveResult | void>
  onCancel: () => void
  onDelete?: (id: string) => void
  confirmingDelete?: boolean
  onConfirmDelete?: () => void
  onCancelDelete?: () => void
  deleting?: boolean
  /** Reports whether the form has unsaved edits, so the parent can guard partner-switch / New. */
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * The field errors a refused partner save carried in its body, in the validator's
 * shape, so each lands beside the control it names (#1561). Anything else in the
 * body is ignored: a malformed entry is not a field error.
 */
function fieldErrorsOf(err: unknown): ProfileError[] {
  const errors = (err as { body?: { errors?: unknown } } | null)?.body?.errors
  if (!Array.isArray(errors)) return []
  return errors.filter((e): e is ProfileError =>
    typeof e === 'object' && e !== null &&
    typeof (e as ProfileError).code === 'string' &&
    typeof (e as ProfileError).path === 'string' &&
    typeof (e as ProfileError).message === 'string'
  )
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

function Input({ id, value, onChange, placeholder, type = 'text', mono, describedBy }: {
  id?: string
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
  describedBy?: string
}) {
  return (
    <input
      id={id}
      aria-describedby={describedBy}
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

/** The sentence beside a Sold on choice that cannot change yet (#1541), naming exactly what is stored. */
function soldOnLockReason(stored: StoredKind): string {
  const parts = [stored.tierCount > 0 ? 'pricing' : null, stored.acceptRuleCount > 0 ? 'accept rules' : null].filter((p): p is string => p !== null)
  const many = parts.length > 1
  return `This cannot change while ${parts.join(' and ')} ${many ? 'are' : 'is'} stored. Remove ${many ? 'them' : 'it'} and save first.`
}

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
  /**
   * What Undo would do (#2132, #2133, L574): restore the form to `snapshot` and
   * make one page save of the inverse of the save just made, at the pair of
   * versions it produced: `patch` puts each partner field back, and
   * `profileBefore` is the profile document as it was, or null when the save
   * did not write the profile.
   */
  const [undo, setUndo] = useState<{ snapshot: FormSnapshot; patch: Partial<PartnerBody>; profileBefore: BuyerProfileDocument | null } | null>(null)
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0)
  /** The stored copy warning of the last save, shown beside Saved, never as an error (#1846, #2132). */
  const [copyWarningText, setCopyWarningText] = useState<string | null>(null)
  /** The version the page last saw the partner at; a save names it (#2132). */
  const versionRef = useRef<number>(partner?.version ?? 0)
  /** A press whose answer never came: its retry reuses the same save id (#2132). */
  const pendingSaveRef = useRef<{ saveId: string; key: string } | null>(null)

  // The form's values for the partner as loaded, through the one mapping a
  // merged save also uses (snapshotOf, #2134), so the two cannot disagree.
  const [initial] = useState(() => snapshotOf(partner))
  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(partner?.slug ?? '')
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)

  function handleNameChange(value: string) {
    setName(value)
    if (!slugManuallyEdited) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    }
  }
  const [apiEndpoint, setApiEndpoint] = useState(initial.apiEndpoint)
  const [cfSecretKey, setCfSecretKey] = useState(initial.cfSecretKey)
  const [clickUrl, setClickUrl] = useState(initial.clickUrl)
  const [isActive, setIsActive] = useState(initial.isActive)
  const [priority, setPriority] = useState(initial.priority)

  const [dailyCap, setDailyCap] = useState(initial.dailyCap)
  const [minBid, setMinBid] = useState(initial.minBid)
  const [bidFormula, setBidFormula] = useState(initial.bidFormula)
  const [resolverType, setResolverType] = useState<BidResolverType>(initial.resolverType)
  const [resolverConfig, setResolverConfig] = useState<Record<string, unknown>>(initial.resolverConfig)
  const [outboundMapping, setOutboundMapping] = useState<Record<string, unknown> | null>(initial.outboundMapping)
  const [bidComparisonSource, setBidComparisonSource] = useState<BidComparisonSource>(initial.bidComparisonSource)
  const [extraExtraction, setExtraExtraction] = useState<ExtraExtractionConfig | null>(initial.extraExtraction)
  const [lastProbeResponse, setLastProbeResponse] = useState<unknown>(initial.lastProbeResponse)
  const [bidConfigs, setBidConfigs] = useState<PartnerBidConfig[]>([])
  const [dedupEndpoint, setDedupEndpoint] = useState(initial.dedupEndpoint)

  const [circuitEnabled, setCircuitEnabled] = useState(initial.circuitEnabled)
  const [circuitThreshold, setCircuitThreshold] = useState(initial.circuitThreshold)
  const [circuitWindow, setCircuitWindow] = useState(initial.circuitWindow)
  const [circuitCooldown, setCircuitCooldown] = useState(initial.circuitCooldown)

  const [confirmationWindowMs, setConfirmationWindowMs] = useState(initial.confirmationWindowMs)

  const [signalRules, setSignalRules] = useState<SignalRules>(initial.signalRules)
  // The buyer profile (#1412): the accept rules live on the partner record and
  // save with it; the document lives in buyer_profiles and saves second, through
  // its own versioned route. Both are form state so one Save covers the page.
  const [acceptSignals, setAcceptSignals] = useState<Signal[]>(initial.acceptSignals as Signal[])
  // The two facts the Engine scripts read from the winner (#1416), on the partner record beside the accept rules.
  const [duplicateSignals, setDuplicateSignals] = useState<Signal[]>(initial.duplicateSignals as Signal[])
  const [externalRoutingCode, setExternalRoutingCode] = useState(initial.externalRoutingCode)
  const [profile, setProfile] = useState<BuyerProfileDocument | null>(null)
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [otherSellers, setOtherSellers] = useState<Array<{ id: string; name: string }>>([])
  const [profileErrors, setProfileErrors] = useState<ProfileError[]>([])
  /** A buyer profile refusal about the partner's click URL, shown on that field (#1546). */
  const clickUrlError = profileErrors.find((e) => e.path === 'clickUrl')?.message ?? null
  /**
   * A save refused because someone else saved first (#2134, PM-3): the three
   * halves the merge is made from, who saved, the versions their save left,
   * and the answers given so far, which survive closing the dialog. Null when
   * no merge is waiting.
   */
  const [pendingMerge, setPendingMerge] = useState<{
    base: PageHalves; mine: PageHalves; theirs: PageHalves
    theirPartner: Partner; theirName: string | null
    partnerVersion: number; choices: Record<string, MergeSide>
  } | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  /** Set by the merge dialog's Save both: submit once the merged values are on screen. */
  const [resubmit, setResubmit] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<OutcomeState>({ kind: 'idle' })
  /**
   * What saving a click delivery change does, state by state (#1639, L180), shown
   * for a yes before anything is written; null when nothing is waiting on it.
   */
  const [deliveryConfirm, setDeliveryConfirm] = useState<string[] | null>(null)
  // The confirmation describes the profile as it was when Save was pressed; any
  // later edit makes it describe something else, so it is withdrawn and Save asks again.
  useEffect(() => { setDeliveryConfirm(null) }, [profile])
  // What the profile looked like when it loaded or was last saved, so an edit to
  // it counts as dirty and a load does not.
  const profileBaseline = useRef<string | null>(null)

  const [alertTransient, setAlertTransient] = useState(initial.alertTransient)
  const [alertPermanent, setAlertPermanent] = useState(initial.alertPermanent)

  const [partnerType, setPartnerType] = useState<PartnerType>(initial.partnerType)

  const [sellOffOfferTitle, setSellOffOfferTitle] = useState(initial.sellOffOfferTitle)
  const [sellOffOfferDetails, setSellOffOfferDetails] = useState(initial.sellOffOfferDetails)
  const [subAccountFloors, setSubAccountFloors] = useState<SubAccountFloor[]>(initial.subAccountFloors)

  const [uuids, setUuids] = useState<PartnerUuid[]>([])
  const [pendingUuids, setPendingUuids] = useState<string[]>([])
  const [newUuid, setNewUuid] = useState('')
  const [addingUuid, setAddingUuid] = useState(false)
  const [uuidError, setUuidError] = useState<string | null>(null)
  const [removingUuidId, setRemovingUuidId] = useState<string | null>(null)

  // Each read that fails is its own state with a retry, never an empty list
  // (L10, #2132): an empty sub-account list reads as "this source has none".
  const [uuidsLoadError, setUuidsLoadError] = useState(false)
  const [uuidsAttempt, setUuidsAttempt] = useState(0)
  const [bidConfigsLoadError, setBidConfigsLoadError] = useState(false)
  const [bidConfigsAttempt, setBidConfigsAttempt] = useState(0)
  const partnerId = partner?.id
  const partnerSlug = partner?.slug
  useEffect(() => {
    if (!partnerSlug) return
    let cancelled = false
    setUuidsLoadError(false)
    api.partnerUuids.list()
      .then((all) => { if (!cancelled) setUuids(all.filter((u) => u.partner_slug === partnerSlug)) })
      .catch(() => { if (!cancelled) setUuidsLoadError(true) })
    return () => { cancelled = true }
  }, [partnerSlug, uuidsAttempt])
  useEffect(() => {
    if (!partnerId) return
    let cancelled = false
    setBidConfigsLoadError(false)
    api.partnerBidConfigs.list(partnerId)
      .then((configs) => { if (!cancelled) setBidConfigs(configs) })
      .catch(() => { if (!cancelled) setBidConfigsLoadError(true) })
    return () => { cancelled = true }
  }, [partnerId, bidConfigsAttempt])

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
        if (s <= 1) { setUndo(null); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearTimeout(t)
  }, [undoSecondsLeft])

  function captureSnapshot(): FormSnapshot {
    return { name, apiEndpoint, cfSecretKey, clickUrl, isActive, priority, dailyCap, minBid, bidFormula, resolverType, resolverConfig, outboundMapping, bidComparisonSource, extraExtraction, lastProbeResponse, dedupEndpoint, circuitEnabled, circuitThreshold, circuitWindow, circuitCooldown, signalRules, alertTransient, alertPermanent, sellOffOfferTitle, sellOffOfferDetails, partnerType, confirmationWindowMs, subAccountFloors, acceptSignals, externalRoutingCode, duplicateSignals }
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
  // The draft a save is made from (#2132): base is the partner as loaded or
  // last saved, and a save sends only the touched keys that differ from it.
  const bodyCtx = { slug, isExisting: !!partner }
  const [draftState, dispatchDraft] = useReducer(draftReducer, undefined, () => initDraft(buildPartnerBody(baselineSnapshot.current!, { slug: partner?.slug ?? '', isExisting: !!partner })))
  useEffect(() => {
    dispatchDraft({ type: 'observe', draft: buildPartnerBody(captureSnapshot(), bodyCtx) })
    // dirtyKey is the whole snapshot as text: it changes exactly when a value does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyKey])
  // What is STORED for the profile and the partner record, for the one rule that
  // reads it (#1541): the kind cannot be switched while pricing or accept rules
  // are stored. A profile never saved has nothing stored.
  const storedKind: StoredKind | null = (() => {
    if (profileBaseline.current === null) return null
    const stored = JSON.parse(profileBaseline.current) as BuyerProfileDocument
    if ((stored.version ?? 0) === 0 || stored.sold_on === null) return null
    return { soldOn: stored.sold_on, tierCount: stored.tiers.length, acceptRuleCount: baselineSnapshot.current?.acceptSignals.length ?? 0 }
  })()
  const soldOnLock = storedKind && soldOnSwitchBlocked(storedKind) ? soldOnLockReason(storedKind) : null

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
    setBidComparisonSource(snap.bidComparisonSource)
    setExtraExtraction(snap.extraExtraction); setLastProbeResponse(snap.lastProbeResponse)
    setDedupEndpoint(snap.dedupEndpoint); setCircuitEnabled(snap.circuitEnabled)
    setCircuitThreshold(snap.circuitThreshold); setCircuitWindow(snap.circuitWindow)
    setCircuitCooldown(snap.circuitCooldown); setSignalRules(snap.signalRules)
    setAlertTransient(snap.alertTransient); setAlertPermanent(snap.alertPermanent)
    setSellOffOfferTitle(snap.sellOffOfferTitle); setSellOffOfferDetails(snap.sellOffOfferDetails)
    setPartnerType(snap.partnerType); setConfirmationWindowMs(snap.confirmationWindowMs)
    setSubAccountFloors(snap.subAccountFloors)
    setAcceptSignals(snap.acceptSignals as Signal[])
    setExternalRoutingCode(snap.externalRoutingCode); setDuplicateSignals(snap.duplicateSignals as Signal[])
  }

  /**
   * One save of the whole page (#2133): the partner `patch` and, when it is
   * not null, the profile document `profileDoc`, written together or not at
   * all at the pair of versions the page last saw. The profile version is
   * named whenever the page has read the profile, so a save is refused when
   * either half changed underneath it. Mints a save id for this press,
   * reusing it only when retrying a press that got no answer. A 409 carrying
   * this press's own save id is its own save that landed before the answer
   * was lost (L747); any other 409 is someone else's newer save, merged field
   * by field with what is on screen (#2134): nothing is overwritten, and only
   * what both changed asks a question. Every outcome but 'saved' has already
   * said so on the page.
   */
  async function savePage(
    patch: Partial<PartnerBody>,
    profileDoc: BuyerProfileDocument | null,
    opts: { undo?: boolean } = {},
  ): Promise<{ kind: 'saved'; partner: Partner | null; profile: BuyerProfileDocument | null; copyWarning: string | null } | { kind: 'refused' }> {
    if (!partner) return { kind: 'refused' }
    const version = versionRef.current
    const profileVersion = profile !== null ? profile.version ?? 0 : null
    const key = JSON.stringify({ patch, profileDoc, version, profileVersion })
    const saveId = pendingSaveRef.current?.key === key ? pendingSaveRef.current.saveId : mintSaveId()
    pendingSaveRef.current = null
    try {
      const result = await onSave(patch as PartnerBody, partner.id, undefined, { expected_partner_version: version, expected_profile_version: profileVersion, profile: profileDoc, save_id: saveId })
      const saved = result ? result.partner : null
      versionRef.current = saved?.version ?? version + 1
      return { kind: 'saved', partner: saved, profile: result ? result.profile : null, copyWarning: result ? result.copyWarning : null }
    } catch (err) {
      const e = err as Error & { status?: number; body?: Partial<PartnerPageStale> & { error?: string; message?: string } }
      if (e.status === undefined) {
        // No answer: the save may or may not have landed, so a retry of this
        // press sends the same id and can recognise its own save.
        pendingSaveRef.current = { saveId, key }
      }
      if (e.status === 409 && e.body?.error === 'stale_version') {
        if (e.body.last_save_id === saveId) {
          const current = e.body.partner ?? null
          versionRef.current = e.body.partner_version ?? current?.version ?? version + 1
          return { kind: 'saved', partner: current, profile: e.body.profile ?? null, copyWarning: null }
        }
        const stale = { changed_by_name: e.body.changed_by_name ?? null, changed_at: e.body.changed_at ?? null }
        if (opts.undo || !e.body.partner) {
          setSaveOutcome({ kind: 'failed', message: opts.undo ? staleUndoSentence(stale) : staleSaveSentence(stale) })
          return { kind: 'refused' }
        }
        startMerge(e.body as PartnerPageStale & { partner: Partner }, stale)
        return { kind: 'refused' }
      }
      // The route's sentence, never its code, and a refusal naming a field lands
      // on that field: the click URL an enabled click buyer is offered on (#1561).
      const errors = fieldErrorsOf(err)
      setProfileErrors(errors)
      const lead = opts.undo ? 'Undo not made' : 'Nothing saved'
      const hasSentence = typeof e.body?.message === 'string' && e.body.message.trim() !== ''
      // The server's profile refusal carries field errors and no sentence of
      // its own: named by label with the validator's reason, as the form's own
      // check names them (#1464).
      const message = !hasSentence && errors.length > 0
        ? `${lead}. Fix the buyer profile first: ${describeProfileErrors(errors, profileDoc?.sold_on ?? profile?.sold_on ?? null)}`
        : `${lead}: ${errorSentence(err, 'the partner save failed')}`
      setSaveOutcome({ kind: 'failed', message })
      return { kind: 'refused' }
    }
  }

  /** The outcome sentence for a landed save: which halves it wrote, and when bidding picks them up. */
  function savedSentence(partnerWritten: boolean, savedProfile: BuyerProfileDocument | null): string {
    const parts = [partnerWritten ? 'Partner saved.' : null, savedProfile ? `Buyer profile saved, version ${savedProfile.version ?? '?'}.` : null].filter((p): p is string => p !== null)
    return `${parts.join(' ')} ${pickupSentence()}`
  }

  /** The profile as the save stored it becomes the clean baseline. */
  function adoptSavedProfile(saved: BuyerProfileDocument) {
    profileBaseline.current = JSON.stringify(saved)
    setProfile(saved)
  }

  /** The page's three halves for a merge: as loaded, as on screen, and as their save left it. */
  function mergeHalves(body: PartnerPageStale & { partner: Partner }): { base: PageHalves; mine: PageHalves; theirs: PageHalves } {
    const baseProfile = profileBaseline.current !== null ? (JSON.parse(profileBaseline.current) as BuyerProfileDocument) : null
    // A page that has read the profile merges it; their side of a profile that
    // was never stored is the empty one the page loaded.
    const read = profile !== null && baseProfile !== null
    return {
      base: { partner: draftState.base, profile: read ? baseProfile : null },
      mine: { partner: buildPartnerBody(captureSnapshot(), bodyCtx), profile: read ? profile : null },
      theirs: { partner: buildPartnerBody(snapshotOf(body.partner), bodyCtx), profile: read ? body.profile ?? baseProfile : null },
    }
  }

  /**
   * Someone else saved first (#2134, PM-3). Merge their save with what is on
   * screen: with no question, put the merged values on screen at their versions
   * and say what of theirs was kept, and save only on the person's next press
   * (L64); with questions, open the merge dialog. Answers already given to the
   * same questions survive; a merge against a newer save starts afresh.
   */
  function startMerge(body: PartnerPageStale & { partner: Partner }, stale: Pick<PartnerPageStale, 'changed_by_name' | 'changed_at'>) {
    const halves = mergeHalves(body)
    const partnerVersion = body.partner_version ?? body.partner.version ?? versionRef.current
    // An answer is kept only for the same question: the same field with the
    // same yours and theirs it was given to. A value either side has changed
    // since is asked again.
    const fresh = mergeThreeWay(halves.base, halves.mine, halves.theirs, PARTNER_FIELD_REGISTRY)
    const asked = new Map((mergeResult?.conflicts ?? []).flatMap((sec) => sec.conflicts).map((c) => [c.key, c]))
    const choices: Record<string, MergeSide> = {}
    for (const c of fresh.conflicts.flatMap((sec) => sec.conflicts)) {
      const before = asked.get(c.key)
      const answer = pendingMerge?.choices[c.key]
      if (answer && before && sameMergeValue(before.mine, c.mine) && sameMergeValue(before.theirs, c.theirs)) choices[c.key] = answer
    }
    const result = Object.keys(choices).length > 0 ? mergeThreeWay(halves.base, halves.mine, halves.theirs, PARTNER_FIELD_REGISTRY, choices) : fresh
    const next = { ...halves, theirPartner: body.partner, theirName: stale.changed_by_name, partnerVersion, choices }
    if (result.conflicts.length > 0) {
      setPendingMerge(next)
      setMergeOpen(true)
      setSaveOutcome({ kind: 'failed', message: staleSaveSentence(stale) })
      return
    }
    applyMerge(next, result)
    setPendingMerge(null)
    const who = stale.changed_by_name ?? 'Someone else'
    const remaining = Object.keys(changedPatch({ base: halves.theirs.partner, draft: result.merged.partner, touched: new Set(Object.keys(result.merged.partner) as (keyof PartnerBody)[]) })).length > 0
      || (result.merged.profile !== null && halves.theirs.profile !== null && result.merged.profile !== halves.theirs.profile)
    if (!remaining) {
      setSaveOutcome({ kind: 'done', message: `${who} saved the same changes, so nothing is left to save.` })
      return
    }
    const kept = result.autoTaken.map((u) => u.label)
    const theirs = kept.length === 0 ? '' : kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`
    setSaveOutcome({
      kind: 'failed',
      message: kept.length > 0
        ? `Not saved yet. ${who} also saved this partner; their changes to ${theirs} were kept. Press Save changes to save yours.`
        : `Not saved yet. ${who} also saved this partner, with no change to anything shown here. Press Save changes to save yours.`,
    })
  }

  /**
   * Put a merge on screen at the versions their save left: their partner and
   * profile become the base a save is compared with, and the form shows the
   * merged values, so the next save sends only what is still mine.
   */
  function applyMerge(pm: { theirs: PageHalves; theirPartner: Partner; partnerVersion: number }, result: MergeResult) {
    const mergedSnap = snapshotOf(result.merged.partner, captureSnapshot())
    const theirSnap = snapshotOf(pm.theirs.partner, mergedSnap)
    versionRef.current = pm.partnerVersion
    pendingSaveRef.current = null
    baselineSnapshot.current = theirSnap
    baselineDirtyKey.current = JSON.stringify({ ...theirSnap, slug })
    dispatchDraft({ type: 'rebase', base: pm.theirs.partner })
    if (pm.theirs.profile && result.merged.profile) {
      profileBaseline.current = JSON.stringify(pm.theirs.profile)
      setProfile(result.merged.profile)
    }
    restoreSnapshot(mergedSnap)
  }

  // Only when the pending merge or an answer changes, not on every keystroke behind a closed dialog.
  const mergeResult = useMemo(
    () => (pendingMerge ? mergeThreeWay(pendingMerge.base, pendingMerge.mine, pendingMerge.theirs, PARTNER_FIELD_REGISTRY, pendingMerge.choices) : null),
    [pendingMerge],
  )

  /** Save both: the answers on screen at their versions, then one save of what is still mine. */
  function saveMerged() {
    if (!pendingMerge || !mergeResult) return
    applyMerge(pendingMerge, mergeResult)
    setMergeOpen(false)
    setPendingMerge(null)
    setResubmit(true)
  }

  // The merged values are state, so the save they feed runs once they are rendered.
  useEffect(() => {
    if (!resubmit) return
    setResubmit(false)
    void submit(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resubmit])

  async function handleUndo() {
    if (!undo) return
    const { snapshot: snap, patch, profileBefore } = undo
    setUndo(null)
    setUndoSecondsLeft(0)
    setError(null)
    setCopyWarningText(null)
    setSaveState('saving')
    setSaveOutcome({ kind: 'working', label: 'Undoing the save', startedAt: Date.now(), now: Date.now(), stalledAfterMs: 30_000 })
    // The inverse of the whole save just made, at the pair of versions it
    // produced, so an Undo can never put back over a newer save someone else
    // made (#98, #2132, #2133). The form keeps showing what is stored until the
    // Undo lands, so a refused Undo leaves nothing reading as an unsaved edit.
    const result = await savePage(patch, profileBefore, { undo: true })
    if (result.kind !== 'saved') {
      setSaveState('idle')
      return
    }
    if (profileBefore && result.profile) adoptSavedProfile(result.profile)
    restoreSnapshot(snap)
    baselineDirtyKey.current = JSON.stringify({ ...snap, slug })
    baselineSnapshot.current = snap
    dispatchDraft({ type: 'rebase', base: buildPartnerBody(snap, bodyCtx) })
    setCopyWarningText(result.copyWarning)
    setSaveState('saved')
    setSaveOutcome({ kind: 'done', message: `Undone. ${pickupSentence()}` })
    setTimeout(() => setSaveState('idle'), 1500)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void submit(false)
  }

  /** confirmed: the person has read what the click delivery change does and said save. */
  async function submit(confirmed: boolean) {
    setDeliveryConfirm(null)
    setError(null)
    setProfileErrors([])
    const snapshot = captureSnapshot()
    // Capture the pre-edit baseline BEFORE we advance it — this is what Undo restores.
    const preEdit = baselineSnapshot.current

    // The buyer profile is validated with the shared package before ANY write, so
    // a refused profile leaves the partner record untouched too, and the errors
    // land beside the controls they name (L608).
    const buyer = isBuyerPartner(partnerType)
    // A profile that was never saved and was not touched is not being saved, so
    // it is not judged: a buyer partner with no profile saves its record alone
    // without being asked how a profile it does not have is sold (#1541).
    if (buyer && profile && (profileDirty || (profile.version ?? 0) > 0)) {
      const validation = validateProfile(documentToProfile({ ...profile, partner_id: partner?.id ?? '' }), { acceptSignals, clickUrl: clickUrl || null, externalRoutingCode: parseRoutingCode(externalRoutingCode) }, storedKind)
      if (!validation.ok) {
        setProfileErrors(validation.errors)
        // Names each refused field by its label with the validator's reason (#1464):
        // the Save button sits under the section, so a direction word pointed the
        // wrong way and said nothing about which field (L111, L399).
        setSaveOutcome({ kind: 'failed', message: `Nothing saved. Fix the buyer profile first: ${describeProfileErrors(validation.errors, profile.sold_on)}` })
        return
      }
      // Where clicks go is changing (#1639): say so, state by state, and wait for a yes.
      if (!confirmed && profileDirty && profileBaseline.current !== null) {
        const stored = (JSON.parse(profileBaseline.current) as BuyerProfileDocument).click_delivery ?? null
        const consequences = clickDeliveryConsequences(stored, profile.click_delivery === undefined ? stored : profile.click_delivery)
        if (consequences.length > 0) {
          setDeliveryConfirm(consequences)
          setSaveOutcome({ kind: 'idle' })
          return
        }
      }
    }

    const built = buildPartnerBody(snapshot, bodyCtx)
    const saveProfileToo = buyer && !!partner && !!profile && profileDirty
    setCopyWarningText(null)

    if (isNew) {
      setSaveState('saving')
      setSaveOutcome({ kind: 'working', label: 'Saving the partner', startedAt: Date.now(), now: Date.now(), stalledAfterMs: 30_000 })
      try {
        await onSave(built, undefined, pendingUuids)
      } catch (err) {
        const sentence = errorSentence(err, 'the partner save failed')
        setProfileErrors(fieldErrorsOf(err))
        setError(sentence)
        setSaveOutcome({ kind: 'failed', message: `Nothing saved: ${sentence}` })
        setSaveState('idle')
        return
      }
      baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
      baselineSnapshot.current = snapshot
      setSaveState('saved')
      setSaveOutcome({ kind: 'done', message: `Partner saved. ${pickupSentence()}` })
      setTimeout(() => setSaveState('idle'), 1500)
      return
    }

    // Only the fields the person changed (#2132): a field not sent is left as
    // stored, so this save cannot put back a newer one someone else made.
    const patch = changedPatch(draftReducer(draftState, { type: 'observe', draft: built }))
    const partnerChanged = Object.keys(patch).length > 0
    if (!partnerChanged && !saveProfileToo) {
      // What is on screen stores exactly as what was loaded (a blank floor row,
      // say), so it is the clean baseline now, or the page would say Unsaved
      // changes for ever with nothing a save could write.
      baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
      baselineSnapshot.current = snapshot
      setSaveOutcome({ kind: 'done', message: 'Nothing to save.' })
      return
    }

    // The profile as stored before this save, which Undo puts back (L574). A
    // profile this save creates has none, and a save cannot delete one, so it
    // offers no Undo.
    const profileBefore = saveProfileToo && profileBaseline.current !== null ? (JSON.parse(profileBaseline.current) as BuyerProfileDocument) : null
    const undoable = !saveProfileToo || (profileBefore !== null && (profileBefore.version ?? 0) > 0)

    setSaveState('saving')
    setSaveOutcome({ kind: 'working', label: 'Saving', startedAt: Date.now(), now: Date.now(), stalledAfterMs: 30_000 })
    // One request for the whole page (#2133): both halves land or neither does,
    // so the button says Saved only when everything this press saves has saved.
    const result = await savePage(patch, saveProfileToo ? profile : null)
    if (result.kind !== 'saved') {
      setSaveState('idle')
      return
    }
    setCopyWarningText(result.copyWarning)
    if (saveProfileToo && result.profile) adoptSavedProfile(result.profile)
    // Undo restores the PRE-edit values of both halves by saving the inverse of
    // this save at the versions it produced.
    if (preEdit && undoable) {
      setUndo({ snapshot: preEdit, patch: inversePatch(patch, buildPartnerBody(preEdit, bodyCtx)), profileBefore })
      setUndoSecondsLeft(5)
    }
    // The partner record as on screen is now what is stored (saved just now, or
    // storing exactly as loaded), so it is the clean baseline whether or not this
    // press wrote it.
    baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
    baselineSnapshot.current = snapshot
    dispatchDraft({ type: 'rebase', base: built })
    setSaveOutcome({ kind: 'done', message: savedSentence(partnerChanged, saveProfileToo ? result.profile ?? profile : null) })
    setSaveState('saved')
    setTimeout(() => setSaveState('idle'), 1500)
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

      {mergeOpen && pendingMerge && mergeResult && (
        <MergeDialog
          result={mergeResult}
          theirName={pendingMerge.theirName}
          onChoose={(key, side) => setPendingMerge((pm) => (pm ? { ...pm, choices: { ...pm.choices, [key]: side } } : pm))}
          onSave={saveMerged}
          onKeepEditing={() => setMergeOpen(false)}
        />
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
            duplicateSignals={duplicateSignals}
            onDuplicateSignalsChange={setDuplicateSignals}
            externalRoutingCode={externalRoutingCode}
            onExternalRoutingCodeChange={setExternalRoutingCode}
            signalRules={signalRules}
            onSignalRulesChange={setSignalRules}
            otherSellers={otherSellers}
            soldOnLock={soldOnLock}
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
          {bidConfigsLoadError && (
            <div role="alert" className="mt-4 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <span className="flex-1">Could not load bid matrices. Try again.</span>
              <UiButton variant="secondary" onClick={() => setBidConfigsAttempt((n) => n + 1)}>Try again</UiButton>
            </div>
          )}
          {resolverType === 'matrix' && partner && !bidConfigsLoadError && (
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
          {/* The labelled field with its error beside it (#1546): the buyer profile's click URL refusals name this field. */}
          <UiField
            id="partner-click-url"
            label="Click URL"
            hint="Where a lead sold to this buyer lands. Exposed as {Slug}ClickUrl in the Constants node, and carried on every buyer selection sale; a buyer profile cannot be enabled without one."
            error={clickUrlError}
          >
            <Input id="partner-click-url" value={clickUrl} onChange={setClickUrl} placeholder="https://partner.com/apply" describedBy={describedBy('partner-click-url', true, Boolean(clickUrlError))} />
          </UiField>
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
          {/* Bid mode is no longer edited here (PM-9, #2136): nothing acts on it. */}
          <div>
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
            ) : uuidsLoadError ? (
              <div role="alert" className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <span className="flex-1">Could not load sub-account IDs. Try again.</span>
                <UiButton variant="secondary" onClick={() => setUuidsAttempt((n) => n + 1)}>Try again</UiButton>
              </div>
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

        {deliveryConfirm && (
          <div role="alertdialog" aria-labelledby="delivery-confirm-title" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p id="delivery-confirm-title" className="text-sm font-medium text-amber-900">Confirm the click delivery change</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
              {deliveryConfirm.map((line) => <li key={line} className="break-all">{line}</li>)}
            </ul>
            <div className="flex items-center gap-2">
              <UiButton variant="primary" onClick={() => { void submit(true) }}>Save these changes</UiButton>
              <UiButton variant="secondary" onClick={() => setDeliveryConfirm(null)}>Keep editing</UiButton>
            </div>
          </div>
        )}

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
          {/*
            Saved, but a stored copy of the old version could not be refreshed
            (#1846). Beside Saved in the server's shared words, never as an error,
            because the save did happen (#2132).
          */}
          {copyWarningText && (
            <p role="status" className="text-xs text-amber-800">{copyWarningText}</p>
          )}
          {undo && (
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
          {!isNew && !undo && !dirty && (
            <p className="text-xs text-gray-500">
              {`Modified ${new Date(partner.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} by ${partner.updated_by_name ?? partner.updated_by_email?.split('@')[0] ?? 'unknown'}`}
            </p>
          )}
        </div>

      </form>
    </div>
  )
}
