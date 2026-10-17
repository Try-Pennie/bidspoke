'use client'

import { useState, useEffect, useId, useMemo, useReducer, useRef, useContext } from 'react'
import { createPortal } from 'react-dom'
import type { Partner, PartnerBody, PartnerDeleted, PartnerUuid, PartnerBidConfig, BidResolverType, BidComparisonSource, ExtraExtractionConfig, PartnerPageSaveRequest, PartnerPageStale } from '@/lib/api'
import { PARTNER_TYPES, isBuyerPartner, isSourcePartner, partnerTypeFromDoes, partnerTypeLabel, type PartnerType } from '@/lib/partner-roles'
import {
  buildPartnerBody, changedPatch, draftReducer, initDraft, inversePatch, parseList, listToString, parseRoutingCode, snapshotOf, PARTNER_FIELD_REGISTRY,
  type FormSnapshot, type SignalRules, type SubAccountFloor,
  type Rule, type BodyRule, type StatusRule, type BodyCondition, type StatusCondition, type SignalCategory,
} from './partner-draft'
import { formatElapsed, formatEtDayTime } from '@/lib/dates'
import { pickupSentence } from '@/lib/bidding-pickup'
import { api } from '@/lib/api'
import { causeAsSentence, errorSentence, requestFailureCause } from '@/lib/error-sentence'
import { Plus } from 'lucide-react'
import { BidResolverEditor } from '@/components/partners/BidResolverEditor'
import { BidMatrixViewer } from '@/components/partners/BidMatrixViewer'
import { OutboundMappingEditor } from '@/components/partners/OutboundMappingEditor'
import { ExtraExtractionEditor } from '@/components/partners/ExtraExtractionEditor'
import { PartnerProbePanel } from '@/components/partners/PartnerProbePanel'
import { ErrorRuleLists } from '@/components/partners/ErrorRuleLists'
import { BuyerProfileSection, EMPTY_PROFILE } from '@/components/partners/buyer-profile/BuyerProfileSection'
import { MergeDialog } from '@/components/partners/MergeDialog'
import { PartnerDeleteBox } from '@/components/partners/PartnerDeleteBox'
import { RemoveButton } from '@/components/partners/RemoveButton'
import { DoesChoice } from '@/components/partners/DoesChoice'
import { PartnerSection, PartnerSubsection } from '@/components/partners/PartnerSection'
import { mergeThreeWay, sameMergeValue, type MergeResult, type MergeSide, type PageHalves } from '@/lib/partner-page-merge'
import { describeProfileErrors } from '@/components/partners/buyer-profile/labels'
import { clickDeliveryConsequences } from '@/components/partners/buyer-profile/click-delivery-consequences'
import { profileWithChangedZoneOnly } from '@/components/partners/buyer-profile/display-zone'
import { Button, Checkbox, ChoiceGroup, Field, FieldError, NumberInput, TextArea, TextInput, describedBy } from '@/components/ui/form'
import { Toggle } from '@/components/ui/Toggle'
import { documentToProfile, soldOnSwitchBlocked, validateProfile, type BuyerProfileDocument, type ProfileError, type Signal, type StoredKind } from '@bidspoke/buyer-profile'
import { leaveThen, useLeaveGuard, type LeaveRequest } from '@/lib/leave-guard'
import { changedUnits } from '@/lib/partner-page-merge'
import { SaveBar, SaveBarDock, type SaveBarState } from '@/components/partners/SaveBar'
import { LeaveDialog } from '@/components/partners/LeaveDialog'
import { ACCESS_REMOVED, SESSION_EXPIRED, namedAsShown, refusedSentence, unsavedSentence } from './save-bar-text'
import { Tabs, TabPanel } from '@/components/ui/Tabs'
import { ProblemMark } from '@/components/ui/ProblemMark'
import { PartnerHistoryPanel } from '@/components/partners/PartnerHistoryPanel'
import { WorkflowValuesPanel } from '@/components/partners/WorkflowValuesPanel'
import { OfferPreview } from '@/components/partners/OfferPreview'
import type { PartnerUsage } from '@/lib/api'
import type { PartnerTab } from './partner-draft'
import {
  bidGroupSettingsSet, bidGroupShown, confirmationWindowShown, openingTab, problemsOf, problemTabs, visibleTabs, TAB_LABELS,
  type TabInputs, type UsageState,
} from './partner-tabs'
import { bidsInSentences } from './bid-group-usage-text'
import { refreshKeyOf } from './workflow-values-text'
import { LiveNotesContext, LivePageNotes, LiveSectionNote, LiveStatusLine, PartnerLiveContext, SYSTEM_CLOCK } from '@/components/partners/live/PartnerLive'
import { usePartnerPageLive } from './use-partner-page-live'
import {
  askedOnly, classifyNotice, directChangeNotes, liveConflictSentence, liveMissReport, liveTakenSentence, partitionRefusalReport, probeFindsGap, savedByName, tabClientId, updatedByNotes,
  PROBE_EVERY_MS, type DirectNote, type HeldVersions, type SectionNote,
} from '@/lib/partner-live-page'
import type { PartnerPageNotice, PartnerPageVersions } from '@bidspoke/partner-page-live'

/**
 * How often a save whose answer was lost asks whether it landed (#2138, L766).
 * Its own cadence: the live channel's delivery probe (PROBE_EVERY_MS, #2135)
 * runs once a minute, which is too slow for a person waiting on their save.
 */
const UNCONFIRMED_PROBE_EVERY_MS = 5_000
/** After this long with no evidence either way, the bar says so plainly and stops asking on a timer. */
const UNCONFIRMED_GIVE_UP_MS = 120_000
/** How long Saved stays when there is no Undo to offer, before the bar slides away. */
const DONE_SHOWN_MS = 5_000

const NO_USAGE: PartnerUsage = { bid_group: [], partner_bid: [], latency_gate: [] }
const NO_NAMES: ReadonlyMap<string, string> = new Map()

/** Why the Bid Group tab shows when no workflow names the partner, said under the Bids in row. */
function bidGroupReasonOf(i: TabInputs): string | null {
  if (bidGroupSettingsSet(i.body)) return 'It shows because a Bid Group setting is filled in.'
  if (i.isBuyer && i.soldOn === 'offer') return 'It shows because buyer selection calls a buyer sold on the offer with these settings.'
  return null
}

/**
 * The Bid Group tab's first row (#2137, the settled design's "Bids in"): which
 * workflows ask this partner for a bid, in each of the usage read's three
 * states, so a read still running or failed never reads as "no workflow".
 */
function BidsInRow({ usage, partnerName, partnerNames, reason, onRetry }: { usage: UsageState; partnerName: string; partnerNames: ReadonlyMap<string, string>; reason: string | null; onRetry: () => void }) {
  if (usage.kind === 'loading') return <p role="status" className="text-sm text-gray-600">Checking which workflows use this partner…</p>
  if (usage.kind === 'failed') {
    return (
      <FieldError as="div" alert size="sm" className="flex items-center gap-3">
        <span className="flex-1">Could not check which workflows use this partner. Try again.</span>
        <Button variant="secondary" onClick={onRetry}>Try again</Button>
      </FieldError>
    )
  }
  const sentences = bidsInSentences(usage.usage, partnerNames)
  if (sentences.length === 0) {
    return <p className="text-sm text-gray-700">{`No workflow's Bid Group names ${partnerName}, so nothing on this tab is used.${reason ? ` ${reason}` : ''}`}</p>
  }
  return <div className="space-y-1 text-sm text-gray-700">{sentences.map((t) => <p key={t}>{t}</p>)}</div>
}

function uid(){ return Math.random().toString(36).slice(2) }

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
  /** The partner was deleted from the delete box at the foot (#2140), with the answer's warnings. */
  onDeleted?: (id: string, answer: PartnerDeleted) => void
  /**
   * Where the save bar is drawn (#2138): the foot of the page's form pane, so
   * it spans the pane under the scrolling form. Drawn after the form without one.
   */
  barSlot?: HTMLElement | null
  /** A save whose answer was lost was found to have landed: the partner as it saved. */
  onSaveConfirmed?: (partner: Partner) => void
  /** The tab the URL asks for (#2137); null opens where the partner's problem or settings are. */
  requestedTab?: PartnerTab | null
  /** The open tab changed (a press, or a fallback): the page mirrors it into the URL. */
  onTabChange?: (tab: PartnerTab) => void
  /** Every listed partner's name by id, for the Bid Group tab's Bids in row. */
  partnerNames?: ReadonlyMap<string, string>
  /** Whether the page holds a problem, for the mark on the partner's row in the list. */
  onProblemChange?: (hasProblem: boolean) => void
  /** Another person's save was merged in (#2135): the row as stored now, for the list. */
  onLiveUpdate?: (partner: Partner) => void
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

/**
 * The form keeps numbers as the text it loaded them as (partner-draft.ts parses
 * them on save), so a number box reads and writes through these two: an empty
 * box is '' and stays apart from 0.
 */
const asNumber = (text: string): number | null => (text.trim() === '' ? null : Number(text))
const asText = (n: number | null): string => (n === null ? '' : String(n))

/**
 * liveSections: the registry sections (partner-draft.ts) this block shows, when
 * its heading is not one of them, so a live note about them lands here (#2135).
 */
function Section({ title, liveSections, region, children }: { title: string; liveSections?: readonly string[]; region?: boolean; children: React.ReactNode }) {
  return (
    <PartnerSection title={title} region={region}>
      <LiveSectionNote sections={liveSections ?? [title]} />
      {children}
    </PartnerSection>
  )
}

// ── Main form ─────────────────────────────────────────────────────────────────

/**
 * Where the last press of Save, Undo or Create stands (#2138), which the save
 * bar draws. `unconfirmed` is a save whose answer was lost: not known to have
 * landed, never called failed (L766), resolved by `confirm` when the versions
 * probe finds its save id, and resent under the same id by `retry`.
 */
type SaveOutcome =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; startedAt: number; now?: number; stalledAfterMs?: number }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string; retry?: 'Try again' | 'Save changes' | null; signIn?: boolean }
  | { kind: 'unconfirmed'; since: number; saveId: string; confirm: (v: PartnerPageVersions) => void; retry: () => Promise<SubmitResult> }

/** Whether a press left the page saved, so Save and open it may go on (PM-5). */
type SubmitResult = 'saved' | 'not_saved'

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
  onDeleted,
  barSlot = null,
  onSaveConfirmed,
  requestedTab = null,
  onTabChange,
  partnerNames = NO_NAMES,
  onProblemChange,
  onLiveUpdate,
}: Props) {
  const formId = `partner-form-${useId().replace(/:/g, '')}`
  const rootRef = useRef<HTMLDivElement>(null)
  /** One save at a time: a second press (or the leave dialog's Save) waits for the first. */
  const savingRef = useRef(false)
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
    /** A merge a live notice held (#2135): only these questions are asked. */
    onlyKeys?: string[]
  } | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  /** Set by the merge dialog's Save both: submit once the merged values are on screen. */
  const [resubmit, setResubmit] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>({ kind: 'idle' })
  /** The leave dialog's question (PM-5), null while nobody is leaving. */
  const [leaveAsk, setLeaveAsk] = useState<LeaveRequest | null>(null)
  // What the profile looked like when it loaded or was last saved, so an edit to
  // it counts as dirty and a load does not.
  const profileBaseline = useRef<string | null>(null)

  const [alertTransient, setAlertTransient] = useState(initial.alertTransient)
  const [alertPermanent, setAlertPermanent] = useState(initial.alertPermanent)

  const [partnerType, setPartnerType] = useState<PartnerType>(initial.partnerType)
  // A new partner's two Does boxes (#2321, PM-18). Neither ticked is no type at
  // all, which Create partner waits on; otherwise the type follows the boxes.
  const [newDoes, setNewDoes] = useState(() => ({ sends: isSourcePartner(initial.partnerType), buys: isBuyerPartner(initial.partnerType) }))
  function changeDoes(next: { sends: boolean; buys: boolean }) {
    setNewDoes(next)
    const type = partnerTypeFromDoes(next)
    if (type) setPartnerType(type)
  }
  const newDoesSomething = partnerTypeFromDoes(newDoes) !== null

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

  // Undo countdown. When it ends the Saved bar slides away with it, unless a
  // stored copy warning stands beside it (#1846), which stays until the next edit.
  useEffect(() => {
    if (undoSecondsLeft <= 0) return
    // Each state write is made here, never inside another's updater, which React may run twice.
    const t = setTimeout(() => {
      if (undoSecondsLeft > 1) { setUndoSecondsLeft(undoSecondsLeft - 1); return }
      setUndoSecondsLeft(0)
      setUndo(null)
      if (!copyWarningText) setSaveOutcome((o) => (o.kind === 'done' ? { kind: 'idle' } : o))
    }, 1000)
    return () => clearTimeout(t)
  }, [undoSecondsLeft, copyWarningText])
  // A Saved with no Undo to offer (Undone, Nothing to save, a new partner) stays a few seconds, then goes.
  useEffect(() => {
    if (saveOutcome.kind !== 'done' || undo || undoSecondsLeft > 0 || copyWarningText) return
    const t = setTimeout(() => setSaveOutcome((o) => (o.kind === 'done' ? { kind: 'idle' } : o)), DONE_SHOWN_MS)
    return () => clearTimeout(t)
  }, [saveOutcome, undo, undoSecondsLeft, copyWarningText])

  // The clock the bar counts by, ticking only while a press is in flight or unconfirmed.
  const [now, setNow] = useState(() => Date.now())
  const ticking = saveOutcome.kind === 'working' || saveOutcome.kind === 'unconfirmed'
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])

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

  // ── Tabs (#2137, PM-1, PM-12) ───────────────────────────────────────────────
  const isNew = !partner
  const isBuyer = isBuyerPartner(partnerType)
  const isSource = isSourcePartner(partnerType)
  // Which workflow steps name the partner: loading, failed and found are three
  // states the Bid Group tab draws differently; a failure is never "none" (L530).
  const [usage, setUsage] = useState<UsageState>(() => (partner ? { kind: 'loading' } : { kind: 'found', usage: NO_USAGE }))
  const [usageAttempt, setUsageAttempt] = useState(0)
  useEffect(() => {
    if (!partnerId) return
    let cancelled = false
    setUsage({ kind: 'loading' })
    api.partners.usage(partnerId)
      .then((u) => { if (!cancelled) setUsage({ kind: 'found', usage: u }) })
      .catch((err: unknown) => { if (!cancelled) setUsage({ kind: 'failed', message: errorSentence(err, 'the read failed') }) })
    return () => { cancelled = true }
  }, [partnerId, usageAttempt])
  const [bidGroupAdded, setBidGroupAdded] = useState(false)
  const [confirmationAdded, setConfirmationAdded] = useState(false)
  const problems = problemsOf({ credentialWarning: partner?.credential_warning, errors: profileErrors, routeNames: profile?.click_delivery?.routes.map((r) => r.name) ?? [] })
  const tabsWithProblems = problemTabs(problems)
  const pageProblems = problems.filter((p) => p.tab === null)
  const credentialProblem = problems.find((p) => p.registryPath === 'cf_secret_key')?.message ?? null
  const currentBody = buildPartnerBody(captureSnapshot(), bodyCtx)
  const tabInputs: TabInputs = {
    isBuyer, isNew, body: currentBody, soldOn: isBuyer ? profile?.sold_on ?? null : null, usage, bidGroupAdded,
    // A problem on the tab, or a URL asking for it while the read runs, keeps it shown.
    bidGroupNeeded: tabsWithProblems.includes('bid_group') || (requestedTab === 'bid_group' && usage.kind === 'loading'),
  }
  // Once shown for a reason of its own, the tab stays for this visit, so
  // clearing its last setting never takes it from under the person.
  const shownForItsOwnReason = bidGroupShown({ ...tabInputs, bidGroupNeeded: tabsWithProblems.includes('bid_group') })
  useEffect(() => { if (shownForItsOwnReason && !bidGroupAdded) setBidGroupAdded(true) }, [shownForItsOwnReason, bidGroupAdded])
  const visible = visibleTabs(tabInputs)
  const bidGroupReason = bidGroupReasonOf(tabInputs)
  const [tab, setTab] = useState<PartnerTab>(() => openingTab({ requested: requestedTab ?? null, visible, problems, isBuyer, isNew }))
  function chooseTab(next: PartnerTab) {
    setTab(next)
    onTabChange?.(next)
  }
  // A tab the partner no longer shows (or a URL naming one it never did) falls
  // back to the first tab, and the URL is corrected to say so.
  useEffect(() => {
    if (!visible.includes(tab)) chooseTab(visible[0])
    else if (requestedTab && requestedTab !== tab && usage.kind !== 'loading') onTabChange?.(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.join(), tab, usage.kind])
  useEffect(() => { onProblemChange?.(problems.length > 0) }, [problems.length, onProblemChange])
  // The bid matrices are read once the Bid Group tab applies (#2137): only its
  // resolver offers them, so a partner without the tab makes no read for them.
  const bidGroupApplies = visible.includes('bid_group')
  useEffect(() => {
    if (!partnerId || !bidGroupApplies) return
    let cancelled = false
    setBidConfigsLoadError(false)
    api.partnerBidConfigs.list(partnerId)
      .then((configs) => { if (!cancelled) setBidConfigs(configs) })
      .catch(() => { if (!cancelled) setBidConfigsLoadError(true) })
    return () => { cancelled = true }
  }, [partnerId, bidConfigsAttempt, bidGroupApplies])

  // ── Leaving (#2138, PM-5) ───────────────────────────────────────────────────
  // Every way away while something would be lost asks first: a list click, a
  // link, back, sign out (the page's own dialog), and a refresh or closed tab
  // (the browser's own warning). A save not yet confirmed counts as unsaved.
  const unconfirmed = saveOutcome.kind === 'unconfirmed'
  useLeaveGuard({
    blocking: dirty || unconfirmed,
    // A back pressed while the dialog is open keeps the question already asked.
    onAsk: (request) => setLeaveAsk((open) => open ?? request),
    // The redirect was held, so the draft stays on screen with the reason (a 401 or 403 from any read or save).
    onAuthRejected: (status) => setSaveOutcome((o) => (o.kind === 'working' || o.kind === 'unconfirmed' ? o : { kind: 'failed', message: status === 401 ? SESSION_EXPIRED : ACCESS_REMOVED, signIn: status === 401 })),
  })

  // ── The save bar (#2138, PM-4, PM-6) ────────────────────────────────────────
  const storedProfile = profileBaseline.current !== null ? (JSON.parse(profileBaseline.current) as BuyerProfileDocument) : null
  // What is unsaved, named by the registry through the units a merge uses.
  const units = useMemo(
    () => (dirty ? namedAsShown(changedUnits({ partner: draftState.base, profile: storedProfile }, { partner: currentBody, profile: profileDirty ? profile : storedProfile }, PARTNER_FIELD_REGISTRY), profile?.sold_on) : []),
    // dirtyKey and profile are the whole page as text and object: they change exactly when a value does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, dirtyKey, profile, draftState.base],
  )
  // A click delivery change is said as what it does (#1639, L180), beside the one Save.
  const consequences = profileDirty && storedProfile && profile
    ? clickDeliveryConsequences(storedProfile.click_delivery ?? null, profile.click_delivery === undefined ? storedProfile.click_delivery : profile.click_delivery)
    : []
  // The refused field a failed save names, from the save's own errors (never the credential mark).
  const refusedProblem = problemsOf({ credentialWarning: null, errors: profileErrors, routeNames: profile?.click_delivery?.routes.map((r) => r.name) ?? [] }).find((p) => p.tab !== null && p.registryPath !== null && visible.includes(p.tab)) ?? null
  // A failure stays until the page changes after it; then the bar names the change again.
  const editKey = `${dirtyKey}${profile ? JSON.stringify(profile) : ''}`
  const [failedAt, setFailedAt] = useState<string | null>(null)
  useEffect(() => { setFailedAt(saveOutcome.kind === 'failed' ? editKey : null) }, [saveOutcome]) // eslint-disable-line react-hooks/exhaustive-deps
  const failureStands = saveOutcome.kind === 'failed' && (failedAt === null || failedAt === editKey)

  /** Show me: open the refused field's tab and put focus on the field (PM-12). */
  const [focusRequest, setFocusRequest] = useState(0)
  function showRefusedField() {
    if (!refusedProblem?.tab) return
    chooseTab(refusedProblem.tab)
    setFocusRequest((n) => n + 1)
  }
  useEffect(() => {
    if (focusRequest === 0) return
    // The open tab's panel (Tabs.tsx draws every panel with this class and hides all but one).
    const panel = rootRef.current?.querySelector<HTMLElement>('.tab-panel:not([hidden])')
    const field = panel?.querySelector<HTMLElement>('[aria-invalid="true"], [aria-describedby$="-error"], [aria-describedby*="-error "]')
    const target = field ?? panel?.querySelector<HTMLElement>('[role="alert"]')
    if (!target) return
    if (!field && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus()
  }, [focusRequest])

  // A save whose answer was lost asks whether it landed (L766): at once, every
  // five seconds for two minutes, and whenever the window regains focus or the
  // network comes back. Only its own save id counts as evidence.
  useEffect(() => {
    if (saveOutcome.kind !== 'unconfirmed' || !partnerId) return
    const pending = saveOutcome
    let settled = false
    const probe = () => {
      if (settled) return
      api.partners.versions(partnerId)
        .then((v) => {
          if (settled || (v.lastSaveId !== pending.saveId && v.profileLastSaveId !== pending.saveId)) return
          settled = true
          pending.confirm(v)
        })
        // No answer is not evidence either way: the next probe asks again.
        .catch(() => {})
    }
    probe()
    const timer = setInterval(() => {
      if (Date.now() - pending.since >= UNCONFIRMED_GIVE_UP_MS) { clearInterval(timer); return }
      probe()
    }, UNCONFIRMED_PROBE_EVERY_MS)
    window.addEventListener('focus', probe)
    window.addEventListener('online', probe)
    return () => {
      settled = true
      clearInterval(timer)
      window.removeEventListener('focus', probe)
      window.removeEventListener('online', probe)
    }
  }, [saveOutcome, partnerId])

  /** Discard changes: the page back to what is stored, as loaded or last saved. */
  function discardChanges() {
    if (baselineSnapshot.current) restoreSnapshot(baselineSnapshot.current)
    // A rename moves the slug with it until the slug is typed; it goes back too.
    setSlug(partner?.slug ?? '')
    setSlugManuallyEdited(false)
    if (storedProfile) setProfile(storedProfile)
    setProfileErrors([])
    setPendingMerge(null)
    setSaveOutcome({ kind: 'idle' })
  }

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
   * what both changed asks a question. A request that got no answer at all
   * comes back 'unconfirmed' with its save id and says nothing itself: the
   * caller (submit, runUndo) announces it, because only the caller knows what
   * to do once the probe finds the save landed. 'refused' has already been
   * said on the page.
   */
  async function savePage(
    patch: Partial<PartnerBody>,
    profileDoc: BuyerProfileDocument | null,
    opts: { undo?: boolean } = {},
  ): Promise<{ kind: 'saved'; partner: Partner | null; profile: BuyerProfileDocument | null; copyWarning: string | null } | { kind: 'refused' } | { kind: 'unconfirmed'; saveId: string }> {
    if (!partner) return { kind: 'refused' }
    const version = versionRef.current
    const profileVersion = profile !== null ? profile.version ?? 0 : null
    const key = JSON.stringify({ patch, profileDoc, version, profileVersion })
    const saveId = pendingSaveRef.current?.key === key ? pendingSaveRef.current.saveId : mintSaveId()
    pendingSaveRef.current = null
    // This tab and this press, so the tab knows its own live notice (#2135, L747).
    ownSaveIds.current.add(saveId)
    try {
      const result = await onSave(patch as PartnerBody, partner.id, undefined, { expected_partner_version: version, expected_profile_version: profileVersion, profile: profileDoc, save_id: saveId, client_id: tabClientId() })
      const saved = result ? result.partner : null
      versionRef.current = saved?.version ?? version + 1
      return { kind: 'saved', partner: saved, profile: result ? result.profile : null, copyWarning: result ? result.copyWarning : null }
    } catch (err) {
      const e = err as Error & { status?: number; body?: Partial<PartnerPageStale> & { error?: string; message?: string } }
      if (e.status === undefined) {
        // No answer (the request aborted at 30 s, or the network dropped): the
        // save may or may not have landed, so it is unconfirmed, never failed
        // (L766), and a retry of this press sends the same id and can
        // recognise its own save.
        pendingSaveRef.current = { saveId, key }
        return { kind: 'unconfirmed', saveId }
      }
      // An expired session or removed access, whose redirect the leave guard held: the draft stays.
      if (e.status === 401 || e.status === 403) {
        setSaveOutcome({ kind: 'failed', message: e.status === 401 ? SESSION_EXPIRED : ACCESS_REMOVED, signIn: e.status === 401 })
        return { kind: 'refused' }
      }
      if (e.status === 409 && e.body?.error === 'stale_version') {
        if (e.body.last_save_id === saveId) {
          const current = e.body.partner ?? null
          versionRef.current = e.body.partner_version ?? current?.version ?? version + 1
          return { kind: 'saved', partner: current, profile: e.body.profile ?? null, copyWarning: null }
        }
        const stale = { changed_by_name: e.body.changed_by_name ?? null, changed_at: e.body.changed_at ?? null }
        if (opts.undo || !e.body.partner) {
          setSaveOutcome({ kind: 'failed', message: opts.undo ? staleUndoSentence(stale) : staleSaveSentence(stale), retry: opts.undo ? null : 'Save changes' })
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
      // A refused field on a tab is named with its tab, and Show me opens it;
      // the reason is beside the field (PM-12).
      const refused = opts.undo ? null : refusedSentence(problemsOf({ credentialWarning: null, errors, routeNames: profileDoc?.click_delivery?.routes.map((r) => r.name) ?? profile?.click_delivery?.routes.map((r) => r.name) ?? [] }), profileDoc?.sold_on ?? profile?.sold_on)
      // The server's profile refusal carries field errors and no sentence of
      // its own: named by label with the validator's reason, as the form's own
      // check names them (#1464).
      const message = refused ?? (!hasSentence && errors.length > 0
        ? `${lead}. Fix the buyer profile first: ${describeProfileErrors(errors, profileDoc?.sold_on ?? profile?.sold_on ?? null)}`
        : `${lead}: ${causeAsSentence(requestFailureCause(err, 'the partner save failed'))}`)
      setSaveOutcome({ kind: 'failed', message, retry: refused ? 'Save changes' : undefined })
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
      setSaveOutcome({ kind: 'failed', message: staleSaveSentence(stale), retry: 'Save changes' })
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
      retry: 'Save changes',
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
  const mergeResult = useMemo(() => {
    if (!pendingMerge) return null
    const result = mergeThreeWay(pendingMerge.base, pendingMerge.mine, pendingMerge.theirs, PARTNER_FIELD_REGISTRY, pendingMerge.choices)
    return pendingMerge.onlyKeys ? askedOnly(result, pendingMerge.onlyKeys) : result
  }, [pendingMerge])

  /** Save both: the answers on screen at their versions, then one save of what is still mine. */
  function saveMerged() {
    if (!pendingMerge || !mergeResult) return
    applyMerge(pendingMerge, mergeResult)
    setMergeOpen(false)
    setPendingMerge(null)
    setLiveHeld(null)
    setResubmit(true)
  }

  // ── The live channel (#2135, PM-2) ──────────────────────────────────────────
  // Another person's save of this partner arrives as a notice on partners:<org>.
  // The page reads both halves again through the Worker and merges them with
  // what is on screen (mergeThreeWay, #2134): a field only they changed updates
  // in place, and a field both changed waits for this person's next Save. While
  // the draft is dirty a probe asks every PROBE_EVERY_MS for the versions, the
  // backstop for a notice Realtime lost (ADR 0012), and reports such a miss.
  const liveDeps = useContext(PartnerLiveContext)
  /** Every save id this tab has sent: its notice, with this tab's client_id, is its own echo. */
  const ownSaveIds = useRef(new Set<string>())
  /** When the page last heard a notice of this partner, for a miss report's gap. */
  const lastNoticeAt = useRef<number | null>(null)
  /**
   * Another person's save changed fields this person is editing: the rest of it
   * is on screen, and these keys are asked when Save is pressed. base is the
   * page as it was before the first such save; theirs is the newest.
   */
  const [liveHeld, setLiveHeld] = useState<{ base: PageHalves; theirs: PageHalves; theirPartner: Partner; theirName: string | null; partnerVersion: number; keys: string[] } | null>(null)
  const [updatedNotes, setUpdatedNotes] = useState<SectionNote[]>([])
  const [directNotes, setDirectNotes] = useState<DirectNote[]>([])
  const liveNotes = useMemo(() => [...updatedNotes, ...directNotes], [updatedNotes, directNotes])
  /** A read of their save, merged in the next render so it meets what is on screen then. */
  const [fetchedTheirs, setFetchedTheirs] = useState<{ partner: Partner; profile: BuyerProfileDocument | null; resolvesSave: string | null } | null>(null)
  const refetching = useRef(false)
  const refetchWanted = useRef(false)
  const profileRef = useRef(profile)
  profileRef.current = profile
  // A save in flight or a merge waiting on answers: a notice meanwhile is read after it.
  const liveBusy = saveOutcome.kind === 'working' || pendingMerge !== null
  const liveBusyRef = useRef(liveBusy)
  liveBusyRef.current = liveBusy
  const heldVersions = (): HeldVersions => ({ partnerVersion: versionRef.current, profileVersion: profileRef.current ? profileRef.current.version ?? 0 : null })
  const liveNow = () => liveDeps?.clock.now() ?? Date.now()

  const liveChannel = usePartnerPageLive(isNew ? null : liveDeps, partner?.organization_id ?? null, {
    onNotice: handleNotice,
    onCatchUp: () => { void refetchTheirs(null) },
    // The page could hear nothing while the day's partition was missing (#2288).
    onPartitionRefused: () => {
      if (!partner) return
      api.partners.reportLiveMiss(partitionRefusalReport(partner.id, heldVersions(), lastNoticeAt.current, liveNow()))
        .catch((err: unknown) => console.error(`[partners live] the missing partition report failed: ${errorSentence(err, 'unknown error')}`))
    },
  })
  const liveStatusRef = useRef(liveChannel.status)
  liveStatusRef.current = liveChannel.status

  /** A delete pressed in the box at the foot and not yet refused or failed (#2140). */
  const deleteRunningRef = useRef(false)
  /**
   * The box follows the person off the Partner tab while a delete runs, and while
   * a refusal or failure that landed on another tab has not been seen there. An
   * outcome that lands on the Partner tab is seen where it lands, so it pins
   * nothing; the next visit to the Partner tab clears an outcome seen elsewhere.
   */
  const [deletePinned, setDeletePinned] = useState(false)
  const tabRef = useRef(tab)
  tabRef.current = tab
  useEffect(() => {
    if (tab === 'partner' && !deleteRunningRef.current) setDeletePinned(false)
  }, [tab])
  function deleteRunningChanged(running: boolean) {
    deleteRunningRef.current = running
    if (running) setDeletePinned(true)
    else if (tabRef.current === 'partner') setDeletePinned(false)
  }

  function handleNotice(n: PartnerPageNotice) {
    if (!partner) return
    const action = classifyNotice(n, { partnerId: partner.id, clientId: tabClientId(), ownSaveIds: ownSaveIds.current, unknownSaveId: pendingSaveRef.current?.saveId ?? null, known: heldVersions() })
    if (action === 'ignore') return
    lastNoticeAt.current = liveNow()
    if (action === 'echo' || action === 'already_held') return
    if (action === 'uuids') { setUuidsAttempt((a) => a + 1); return }
    if (action === 'deleted') {
      // This page's own delete, heard back before its answer: the answer closes
      // the partner; it is not someone else deleting it under the person.
      if (deleteRunningRef.current) return
      setSaveOutcome({ kind: 'failed', message: `${partner.name} was deleted while you were editing, so these changes cannot be saved.` })
      return
    }
    void refetchTheirs(action === 'resolves_unknown' ? n.saveId : null)
  }

  /** Read both halves as stored now, through the Worker, then the versions for the direct change notes. */
  async function refetchTheirs(resolvesSave: string | null) {
    if (!partner || !liveDeps) return
    if (refetching.current || liveBusyRef.current) { refetchWanted.current = true; return }
    refetching.current = true
    try {
      const readProfile = profileRef.current !== null
      const [fresh, prof] = await Promise.all([api.partners.get(partner.id), readProfile ? api.buyerProfiles.get(partner.id) : Promise.resolve(null)])
      setFetchedTheirs({ partner: fresh, profile: prof?.profile ?? null, resolvesSave })
      void readVersions()
    } catch (err) {
      setSaveOutcome({ kind: 'failed', message: `Another save of this partner could not be read: ${errorSentence(err, 'the read failed')}. Your changes are still here.` })
    } finally {
      refetching.current = false
    }
  }

  // A notice that came while a save or a merge was in hand is read once it is done.
  useEffect(() => {
    if (liveBusy || fetchedTheirs || !refetchWanted.current) return
    refetchWanted.current = false
    void refetchTheirs(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBusy, fetchedTheirs])

  // Their save, merged with what is on screen now (#2134's merge).
  useEffect(() => {
    if (!fetchedTheirs || !partner) return
    setFetchedTheirs(null)
    if (liveBusy) { refetchWanted.current = true; return }
    const { partner: fresh, profile: freshProfile, resolvesSave } = fetchedTheirs
    const freshVersion = fresh.version ?? versionRef.current
    const readProfile = profile !== null && profileBaseline.current !== null
    const baseProfile = readProfile ? (JSON.parse(profileBaseline.current!) as BuyerProfileDocument) : null
    const theirsProfile = readProfile ? freshProfile ?? baseProfile : null
    if (freshVersion === versionRef.current && (!readProfile || (theirsProfile?.version ?? 0) === (profile?.version ?? 0))) return
    const resolved = resolvesSave !== null && pendingSaveRef.current?.saveId === resolvesSave
    const pageBase: PageHalves = { partner: draftState.base, profile: baseProfile }
    const theirs: PageHalves = { partner: buildPartnerBody(snapshotOf(fresh), bodyCtx), profile: theirsProfile }
    const result = mergeThreeWay(pageBase, { partner: buildPartnerBody(captureSnapshot(), bodyCtx), profile: readProfile ? profile : null }, theirs, PARTNER_FIELD_REGISTRY)
    applyMerge({ theirs, theirPartner: fresh, partnerVersion: freshVersion }, result)
    onLiveUpdate?.(fresh)
    // An Undo was made against the versions before their save, so it is withdrawn.
    setUndo(null)
    setUndoSecondsLeft(0)
    if (resolved) {
      // The press that got no answer did land: its own notice says so, ending the
      // save bar's unconfirmed state as the versions probe would (#2138).
      pendingSaveRef.current = null
      setSaveOutcome({ kind: 'done', message: `Saved. ${pickupSentence()}` })
      return
    }
    const name = savedByName(fresh)
    const conflictKeys = result.conflicts.flatMap((s) => s.conflicts.map((c) => c.key))
    const notes = updatedByNotes(name, result.autoTaken)
    setUpdatedNotes((prev) => [...prev.filter((p) => !notes.some((n) => n.sections.some((s) => p.sections.includes(s)))), ...notes])
    if (conflictKeys.length > 0 || liveHeld) {
      setLiveHeld((held) => ({ base: held?.base ?? pageBase, theirs, theirPartner: fresh, theirName: name, partnerVersion: freshVersion, keys: [...new Set([...(held?.keys ?? []), ...conflictKeys])] }))
      return
    }
    setSaveOutcome({ kind: 'done', message: liveTakenSentence(name, result.autoTaken) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedTheirs])

  /** The versions and newest change of each half: the direct change notes, and the probe's answer. */
  async function readVersions(): Promise<PartnerPageVersions | null> {
    if (!partner || !liveDeps) return null
    try {
      const v = await api.partners.versions(partner.id)
      setDirectNotes(directChangeNotes(v, liveDeps.clock.now()))
      return v
    } catch (err) {
      // The probe is the backstop for a lost notice, so a failed read is said in the log, never taken as "no change".
      console.error(`[partners live] the versions read failed: ${errorSentence(err, 'unknown error')}`)
      return null
    }
  }

  // Read on open, so a change made outside the page before it opened is noted, and anything missed before the join is merged.
  useEffect(() => {
    if (!liveDeps || !partnerId) return
    void readVersions().then((v) => { if (v && probeFindsGap(heldVersions(), v)) void refetchTheirs(null) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDeps, partnerId])

  // A direct change note goes once its bound has passed.
  useEffect(() => {
    if (!liveDeps || directNotes.length === 0) return
    const next = Math.min(...directNotes.map((n) => n.expiresAt))
    return liveDeps.clock.setTimeout(() => setDirectNotes((notes) => notes.filter((n) => n.expiresAt > liveDeps.clock.now())), Math.max(0, next - liveDeps.clock.now()))
  }, [directNotes, liveDeps])

  // The delivery probe (L106): while the draft is dirty, the versions every PROBE_EVERY_MS.
  const [probeRound, setProbeRound] = useState(0)
  useEffect(() => {
    if (!liveDeps || !partnerId || !dirty) return
    return liveDeps.clock.setTimeout(() => { void probe().finally(() => setProbeRound((r) => r + 1)) }, PROBE_EVERY_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDeps, partnerId, dirty, probeRound])

  /**
   * A version past the one held, found while the header said Live, is a notice
   * the channel did not deliver: the header goes to paused while it rejoins,
   * the save is merged, and the miss is reported (direct_sql when the change
   * had no actor). Not Live, a gap is expected and only merged.
   */
  async function probe() {
    if (!partner || !liveDeps || liveBusyRef.current) return
    const known = heldVersions()
    const wasLive = liveStatusRef.current?.kind === 'live'
    const v = await readVersions()
    // Checked again after the read: a notice merged meanwhile is not a miss.
    if (!v || !probeFindsGap(known, v) || !probeFindsGap(heldVersions(), v)) return
    if (wasLive) {
      liveChannel.suspect('a save arrived that no live update announced')
      api.partners.reportLiveMiss(liveMissReport(v, known, lastNoticeAt.current, liveNow()))
        .catch((err: unknown) => console.error(`[partners live] the live miss report failed: ${errorSentence(err, 'unknown error')}`))
    }
    void refetchTheirs(null)
  }

  /**
   * Save pressed while a live merge holds questions: ask them in the merge
   * dialog first, only those (a field edited after seeing theirs is not asked).
   * Answers already given to the same question survive. True when it asked.
   */
  function askLiveQuestions(): boolean {
    if (!liveHeld) return false
    const read = profile !== null && liveHeld.base.profile !== null
    const mine: PageHalves = { partner: buildPartnerBody(captureSnapshot(), bodyCtx), profile: read ? profile : null }
    const result = askedOnly(mergeThreeWay(liveHeld.base, mine, liveHeld.theirs, PARTNER_FIELD_REGISTRY), liveHeld.keys)
    if (result.conflicts.length === 0) {
      setLiveHeld(null)
      return false
    }
    const asked = new Map((mergeResult?.conflicts ?? []).flatMap((sec) => sec.conflicts).map((c) => [c.key, c]))
    const choices: Record<string, MergeSide> = {}
    for (const c of result.conflicts.flatMap((sec) => sec.conflicts)) {
      const before = asked.get(c.key)
      const answer = pendingMerge?.choices[c.key]
      if (answer && before && sameMergeValue(before.mine, c.mine) && sameMergeValue(before.theirs, c.theirs)) choices[c.key] = answer
    }
    setPendingMerge({ base: liveHeld.base, mine, theirs: liveHeld.theirs, theirPartner: liveHeld.theirPartner, theirName: liveHeld.theirName, partnerVersion: liveHeld.partnerVersion, choices, onlyKeys: liveHeld.keys })
    setMergeOpen(true)
    return true
  }

  // The merged values are state, so the save they feed runs once they are rendered.
  useEffect(() => {
    if (!resubmit) return
    setResubmit(false)
    void submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resubmit])

  function handleUndo() {
    if (!undo) return
    void runUndo(undo)
  }

  /**
   * The inverse of the whole save just made, at the pair of versions it
   * produced, so an Undo can never put back over a newer save someone else
   * made (#98, #2132, #2133). The form keeps showing what is stored until the
   * Undo lands, so a refused Undo leaves nothing reading as an unsaved edit.
   */
  async function runUndo(info: { snapshot: FormSnapshot; patch: Partial<PartnerBody>; profileBefore: BuyerProfileDocument | null }): Promise<SubmitResult> {
    if (savingRef.current) return 'not_saved'
    const { snapshot: snap, patch, profileBefore } = info
    setUndo(null)
    setUndoSecondsLeft(0)
    setCopyWarningText(null)
    const finish = (saved: { profile: BuyerProfileDocument | null; copyWarning: string | null }) => {
      if (profileBefore && saved.profile) adoptSavedProfile(saved.profile)
      restoreSnapshot(snap)
      baselineDirtyKey.current = JSON.stringify({ ...snap, slug })
      baselineSnapshot.current = snap
      dispatchDraft({ type: 'rebase', base: buildPartnerBody(snap, bodyCtx) })
      setCopyWarningText(saved.copyWarning)
      setSaveOutcome({ kind: 'done', message: `Undone. ${pickupSentence()}` })
    }
    savingRef.current = true
    setSaveOutcome({ kind: 'working', label: 'Undoing the save', startedAt: Date.now() })
    const result = await savePage(patch, profileBefore, { undo: true })
    savingRef.current = false
    if (result.kind === 'unconfirmed') {
      setSaveOutcome({
        kind: 'unconfirmed', since: Date.now(), saveId: result.saveId, retry: () => runUndo(info),
        confirm: (v) => {
          versionRef.current = v.partnerVersion
          // Known now, so its own late notice is an echo, not an unknown save resolving (#2135).
          pendingSaveRef.current = null
          finish({ profile: profileBefore ? { ...profileBefore, version: v.profileVersion } : null, copyWarning: null })
          // The page's row is the partner as the Undo left it, as a save whose answer came back would set it.
          if (partner) onSaveConfirmed?.({ ...partner, ...patch, version: v.partnerVersion } as Partner)
        },
      })
      return 'not_saved'
    }
    if (result.kind !== 'saved') return 'not_saved'
    finish(result)
    return 'saved'
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void submit()
  }

  /**
   * One press of Save (or Create). Resolves 'saved' only once the page is
   * saved, which is when Save and open it may go on (PM-5); a refusal, a
   * failure, a merge to answer or an unconfirmed outcome is 'not_saved', and
   * the bar says which.
   */
  async function submit(): Promise<SubmitResult> {
    if (savingRef.current) return 'not_saved'
    // Every way a create is pressed (the bar, Enter in a box, Try again, Save and
    // open it) comes through here, so the Create partner rule is kept here.
    if (isNew && (!name || !newDoesSomething)) {
      setSaveOutcome({ kind: 'failed', message: !name ? 'Not created: give the partner a name.' : 'Not created: tick what the partner does, Sends us leads or Buys leads.', retry: null })
      return 'not_saved'
    }
    setProfileErrors([])
    // Another person's live save changed a field being edited (#2135): asked first.
    // Asked, not saved: Save and open it stays on the page while the merge dialog is open.
    if (askLiveQuestions()) return 'not_saved'
    const snapshot = captureSnapshot()
    // Capture the pre-edit baseline BEFORE we advance it: this is what Undo restores.
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
        // The bar names the refused field and its tab, with Show me; each
        // reason is beside its field (PM-12). A refusal no tab holds is named
        // by label with the validator's reason (#1464, L111, L399).
        const refused = refusedSentence(problemsOf({ credentialWarning: null, errors: validation.errors, routeNames: profile.click_delivery?.routes.map((r) => r.name) ?? [] }), profile.sold_on)
        setSaveOutcome({ kind: 'failed', message: refused ?? `Nothing saved. Fix the buyer profile first: ${describeProfileErrors(validation.errors, profile.sold_on)}`, retry: 'Save changes' })
        return 'not_saved'
      }
    }

    const built = buildPartnerBody(snapshot, bodyCtx)
    const saveProfileToo = buyer && !!partner && !!profile && profileDirty
    const profileDoc = saveProfileToo ? profile : null
    setCopyWarningText(null)

    if (isNew) {
      savingRef.current = true
      setSaveOutcome({ kind: 'working', label: 'Creating the partner', startedAt: Date.now() })
      try {
        await onSave(built, undefined, pendingUuids)
      } catch (err) {
        const sentence = causeAsSentence(requestFailureCause(err, 'the partner save failed'))
        setProfileErrors(fieldErrorsOf(err))
        setSaveOutcome({ kind: 'failed', message: `Nothing saved: ${sentence}` })
        return 'not_saved'
      } finally {
        savingRef.current = false
      }
      baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
      baselineSnapshot.current = snapshot
      setSaveOutcome({ kind: 'done', message: `Partner saved. ${pickupSentence()}` })
      return 'saved'
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
      return 'saved'
    }

    // The profile as stored before this save, which Undo puts back (L574). A
    // profile this save creates has none, and a save cannot delete one, so it
    // offers no Undo.
    const profileBefore = saveProfileToo && profileBaseline.current !== null ? (JSON.parse(profileBaseline.current) as BuyerProfileDocument) : null
    const undoable = !saveProfileToo || (profileBefore !== null && (profileBefore.version ?? 0) > 0)

    /** The page after a landed save, whether its answer came back or the probe found it. */
    const finish = (saved: { profile: BuyerProfileDocument | null; copyWarning: string | null }) => {
      setCopyWarningText(saved.copyWarning)
      if (saveProfileToo && saved.profile) adoptSavedProfile(saved.profile)
      // Undo restores the PRE-edit values of both halves by saving the inverse of
      // this save at the versions it produced.
      if (preEdit && undoable) {
        setUndo({ snapshot: preEdit, patch: inversePatch(patch, buildPartnerBody(preEdit, bodyCtx)), profileBefore })
        setUndoSecondsLeft(5)
      }
      // The partner record as saved is now what is stored, so it is the clean
      // baseline; an edit made since the press stays an unsaved edit.
      baselineDirtyKey.current = JSON.stringify({ ...snapshot, slug })
      baselineSnapshot.current = snapshot
      dispatchDraft({ type: 'rebase', base: built })
      // Who updated what is said until this person's own save (#2135).
      setUpdatedNotes([])
      setSaveOutcome({ kind: 'done', message: savedSentence(partnerChanged, saveProfileToo ? saved.profile ?? profile : null) })
    }

    savingRef.current = true
    setSaveOutcome({ kind: 'working', label: 'Saving', startedAt: Date.now() })
    // One request for the whole page (#2133): both halves land or neither does,
    // so the bar says Saved only when everything this press saves has saved.
    // The display zone goes only when it changed (#2143): absent keeps the stored one.
    const result = await savePage(patch, saveProfileToo ? profileWithChangedZoneOnly(profile, profileBefore) : null)
    savingRef.current = false
    if (result.kind === 'unconfirmed') {
      setSaveOutcome({
        // Try again saves what is on screen when it is pressed: unchanged, that is
        // this press again under the same save id; edited since, a new press.
        kind: 'unconfirmed', since: Date.now(), saveId: result.saveId, retry: () => latestSubmit.current(),
        // The probe found this press's save id: it landed, at the versions the probe read.
        confirm: (v) => {
          versionRef.current = v.partnerVersion
          // Known now, so its own late notice is an echo, not an unknown save resolving (#2135).
          pendingSaveRef.current = null
          finish({ profile: profileDoc ? { ...profileDoc, version: v.profileVersion } : null, copyWarning: null })
          if (partner) onSaveConfirmed?.({ ...partner, ...patch, version: v.partnerVersion } as Partner)
        },
      })
      return 'not_saved'
    }
    if (result.kind !== 'saved') return 'not_saved'
    finish(result)
    return 'saved'
  }

  /**
   * This render's submit, for a retry stored with an unconfirmed outcome: a
   * closure from the render that made the press would resend that press's
   * values, so Save and open it could go on with a later edit left unsaved.
   */
  const latestSubmit = useRef(submit)
  latestSubmit.current = submit

  /** The leave dialog's Save and open it: goes on only once this press is saved (PM-5). */
  async function saveThenLeave(request: LeaveRequest) {
    setLeaveAsk(null)
    const result = saveOutcome.kind === 'unconfirmed' ? await saveOutcome.retry() : await submit()
    if (result === 'saved') request.proceed()
  }

  // The bar's state, in order: a press in flight, an unconfirmed outcome, a
  // failure that still stands, a new partner, Saved (until the page changes),
  // what is unsaved, or no bar at all.
  const barState: SaveBarState | null =
    saveOutcome.kind === 'working' ? { kind: 'working', label: saveOutcome.label, elapsed: formatElapsed(now - saveOutcome.startedAt) }
      : saveOutcome.kind === 'unconfirmed' ? { kind: 'unconfirmed', gaveUp: now - saveOutcome.since >= UNCONFIRMED_GIVE_UP_MS }
        : failureStands && saveOutcome.kind === 'failed' ? {
          kind: 'failed', message: saveOutcome.message, signIn: Boolean(saveOutcome.signIn),
          retry: saveOutcome.retry !== undefined ? saveOutcome.retry : dirty || isNew ? 'Try again' : null,
          canDiscard: dirty && !isNew,
          showMe: refusedProblem?.tab ? { label: TAB_LABELS[refusedProblem.tab] } : null,
        }
          : isNew ? { kind: 'new', canCreate: Boolean(name) && newDoesSomething }
            : saveOutcome.kind === 'done' && !dirty ? { kind: 'done', message: saveOutcome.message, undoSeconds: undo ? undoSecondsLeft : null, copyWarning: copyWarningText }
              // Another person's live save (#2135) is said under what is unsaved: fields both
              // changed are asked on Save, and what of theirs was taken is named.
              : dirty ? {
                kind: 'dirty', message: unsavedSentence(units, consequences),
                note: liveHeld ? liveConflictSentence(liveHeld.theirName, liveHeld.keys.length) : saveOutcome.kind === 'done' ? saveOutcome.message : null,
              }
                : null
  // No bar behind the merge dialog (#2322, design frame 12): the dialog says it
  // all, and the bar comes back, saying it is not saved, on Keep editing.
  const bar = barState && !mergeOpen && (
    <SaveBar
      state={barState}
      formId={formId}
      onDiscard={discardChanges}
      onCancel={() => leaveThen({ kind: 'close' }, onCancel)}
      onTryAgain={() => { void (saveOutcome.kind === 'unconfirmed' ? saveOutcome.retry() : submit()) }}
      onUndo={handleUndo}
      onShowMe={showRefusedField}
    />
  )

  return (
    <LiveNotesContext.Provider value={liveNotes}>
    <div ref={rootRef} className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          {isNew
            ? <h2 className="text-2xl font-semibold text-graphite">New partner</h2>
            : <h2 className="text-2xl font-bold text-graphite">{name || <span className="text-gray-300">Unnamed</span>}</h2>
          }
          {!isNew && (
            <p className="mt-0.5 font-mono text-sm text-hint">{partner.slug}</p>
          )}
          {!isNew && <LiveStatusLine status={liveChannel.status} clock={liveDeps?.clock ?? SYSTEM_CLOCK} onRetry={liveChannel.retry} />}
        </div>
      </div>

      {/* A live note no section holds (#2135), such as a hand edit of the whole profile row. */}
      <LivePageNotes />

      {/*
        A problem no tab holds (PM-12, #2137): a refusal naming a field the
        registry does not know is said here with the red mark, never dropped.
        The missing credential (#416) is no longer a banner: it is red under the
        secret it is about, on the Bid Group tab, with marks on the tab and on
        the partner's row in the list.
      */}
      {pageProblems.length > 0 && (
        <ul className="mb-4 space-y-1">
          {pageProblems.map((p, i) => (
            <FieldError as="li" key={i} size="sm" className="flex items-center gap-2">
              <ProblemMark label="Problem:" />
              {p.message}
            </FieldError>
          ))}
        </ul>
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

      <form id={formId} onSubmit={handleSubmit} className="space-y-8">
        {isNew ? (
          // Its own page (design frame 5): what a partner needs before it exists, and
          // nothing more. Everything else is set on its tabs once it is created.
          <div>
            <Section title="Name" region={false}>
              <Field id="partner-name" label="Name" labelHidden>
                <TextInput id="partner-name" value={name} onChange={handleNameChange} placeholder="Acme Lending" />
              </Field>
            </Section>
            <Section title="Slug" region={false}>
              <Field id="partner-slug" label="Slug" labelHidden hint="Made from the name. Workflows and logs use it, and it cannot change after the partner is created.">
                <TextInput
                  id="partner-slug"
                  value={slug}
                  onChange={(v) => { setSlug(v); setSlugManuallyEdited(true) }}
                  placeholder="acme-lending"
                  mono
                  describedBy={describedBy('partner-slug', true, false)}
                />
              </Field>
            </Section>
            <Section title="Does">
              <DoesChoice idPrefix="partner-does" does={newDoes} onChange={changeDoes} />
            </Section>
          </div>
        ) : (
        <Tabs<PartnerTab>
          label={isNew ? 'New partner settings' : `${partner.name} settings`}
          value={tab}
          onValueChange={chooseTab}
          items={visible.map((t) => ({ value: t, label: TAB_LABELS[t], problem: tabsWithProblems.includes(t) }))}
        >
          <TabPanel value="partner">
            {/* The Partner tab's rows as the settled design draws them (#2323, PM-20, frame 6). */}
            <Section title="Name" region={false}>
              <Field id="partner-name" label="Name" labelHidden>
                <TextInput id="partner-name" value={name} onChange={handleNameChange} placeholder="Tripoint" />
              </Field>
            </Section>
            <Section title="Does">
              <DoesChoice
                idPrefix="partner-does"
                does={{ sends: isSourcePartner(partnerType), buys: isBuyerPartner(partnerType) }}
                onChange={(next) => { const type = partnerTypeFromDoes(next); if (type) setPartnerType(type) }}
                keepOne
              />
            </Section>
            <Section title="Active">
              <div className="flex items-center gap-2.5">
                <Toggle id="partner-active" checked={isActive} onChange={setIsActive} label="Active" describedBy="partner-active-hint" />
                <span className="text-sm text-graphite">{isActive ? 'On' : 'Off'}</span>
              </div>
              <p id="partner-active-hint" className="text-xs text-hint">Off: Bidspoke offers {name || 'this partner'} no leads through any step, and workflows see it as inactive.</p>
            </Section>

            {isBuyer && (
              <Section title="Sold through">
                {/* Flat rows, the action beside each label (the settled design). */}
                <div className="flex flex-col gap-2">
                  <div data-sold-row="" className="flex items-center gap-4">
                    <span className="w-[110px] shrink-0 text-sm text-graphite">Buyer profile</span>
                    {/* The read's own states first, so a buyer with a profile is never told to set one up (L10). */}
                    {profileLoadError !== null
                      ? <FieldError as="span" size="sm">Could not be read</FieldError>
                      : partner && profile === null
                        ? <span role="status" className="text-sm text-gray-600">Checking…</span>
                        : profile !== null && (profile.version ?? 0) > 0
                          ? <span className="text-sm text-gray-600">Set up</span>
                          : <Button variant="secondary" onClick={() => chooseTab('buyer_profile')}>Set up a buyer profile</Button>}
                  </div>
                  <div data-sold-row="" className="flex items-center gap-4">
                    <span className="w-[110px] shrink-0 text-sm text-graphite">Bid Group</span>
                    {visible.includes('bid_group')
                      ? <span className="text-sm text-gray-600">Set up</span>
                      : <Button variant="secondary" onClick={() => { setBidGroupAdded(true); chooseTab('bid_group') }}>Set up for Bid Group</Button>}
                  </div>
                </div>
              </Section>
            )}
          </TabPanel>
          {isBuyer && (
            <TabPanel value="buyer_profile">
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
            </TabPanel>
          )}
          {visible.includes('bid_group') && (
            <TabPanel value="bid_group">
              <Section title="Bids in">
                <BidsInRow usage={usage} partnerName={name || 'this partner'} partnerNames={partnerNames} reason={bidGroupReason} onRetry={() => setUsageAttempt((n) => n + 1)} />
              </Section>

              <Section title="Bid resolution">
                {/* Inside the section it is about, so it keeps the row's spacing (#2317). */}
                {credentialProblem && resolverType !== 'api' && (
                  <FieldError size="sm">{credentialProblem}</FieldError>
                )}
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
                  cfSecretKeyError={credentialProblem}
                />
                {bidConfigsLoadError && (
                  <FieldError as="div" alert boxed size="sm" className="mt-4 flex items-center gap-3">
                    <span className="flex-1">Could not load bid matrices. Try again.</span>
                    <Button variant="secondary" onClick={() => setBidConfigsAttempt((n) => n + 1)}>Try again</Button>
                  </FieldError>
                )}
                {resolverType === 'matrix' && partner && !bidConfigsLoadError && (
                  <PartnerSubsection title="Matrix">
                    <BidMatrixViewer
                      partnerId={partner.id}
                      partnerSlug={partner.slug}
                      configs={bidConfigs}
                      onConfigsChange={setBidConfigs}
                      selectedConfigId={typeof resolverConfig.bid_config_id === 'string' ? resolverConfig.bid_config_id : undefined}
                      onSelectConfig={(id) => setResolverConfig({ ...resolverConfig, bid_config_id: id })}
                    />
                  </PartnerSubsection>
                )}
                {resolverType === 'matrix' && !partner && (
                  <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-sm text-hint">
                    Save the partner first to attach a bid matrix.
                  </p>
                )}
              </Section>

              <Section title="Duplicate check">
                <Field
                  id="partner-dedup-endpoint"
                  label="Dedup endpoint"
                  hint="Optional. Called before each bid to check if this lead has already been sold to this partner."
                >
                  <TextInput id="partner-dedup-endpoint" value={dedupEndpoint} onChange={setDedupEndpoint} placeholder="https://api.partner.com/dedup" describedBy={describedBy('partner-dedup-endpoint', true, false)} />
                </Field>
              </Section>

              <Section title="Outbound field mapping">
                <OutboundMappingEditor value={outboundMapping} onChange={setOutboundMapping} />
              </Section>

              {resolverType === 'api' && <Section title="Response handling">
                {/* Bid mode is no longer edited here (PM-9, #2136): nothing acts on it. */}
                <PartnerSubsection title="Sample response">
                  <PartnerProbePanel value={lastProbeResponse} onChange={setLastProbeResponse} />
                </PartnerSubsection>

                <PartnerSubsection title="Extra extraction">
                  <ExtraExtractionEditor
                    value={extraExtraction}
                    onChange={setExtraExtraction}
                    sampleResponse={lastProbeResponse}
                  />
                </PartnerSubsection>
              </Section>}

              <Section title="Bidding limits">
                <div className="grid grid-cols-2 gap-4">
                  {/* Relabelled from Daily cap (#1412, L118): the buyer profile has its own
                      daily lead cap for buyer selection; this one bounds Partner Bid attempts. */}
                  <Field id="partner-daily-attempt-cap" label="Daily attempt cap (bidding workflows)" hint="Max bid attempts per day through Partner Bid and Bid Group. Leave blank for unlimited.">
                    <NumberInput id="partner-daily-attempt-cap" value={dailyCap === '' ? null : Number(dailyCap)} onChange={(v) => setDailyCap(v === null ? '' : String(v))} min={0} step={1} describedBy={describedBy('partner-daily-attempt-cap', true, false)} />
                  </Field>
                  <Field id="partner-min-bid" label="Minimum bid ($)" hint="Reject bids below this amount. Leave blank to accept any bid down to $0. Set a positive amount (e.g. 0.01) to treat a $0 bid as a decline.">
                    <NumberInput id="partner-min-bid" value={asNumber(minBid)} onChange={(v) => setMinBid(asText(v))} placeholder="0.00" describedBy={describedBy('partner-min-bid', true, false)} />
                  </Field>
                </div>
              </Section>

              <Section title="Circuit breaker">
                <div className="flex items-center gap-2.5">
                  <Toggle id="partner-circuit-enabled" checked={circuitEnabled} onChange={setCircuitEnabled} label="Circuit breaker enabled" />
                  <span className="text-sm text-gray-700">{circuitEnabled ? 'Enabled' : 'Disabled'}</span>
                  <span className="text-gray-300">·</span>
                  <p className="text-xs text-hint">
                    Pauses bids to this partner after repeated failures, then retries automatically.
                  </p>
                </div>
                <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${circuitEnabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="grid grid-cols-3 gap-4 pt-1">
                      <Field id="partner-circuit-threshold" label="Error threshold" hint="Errors before pausing.">
                        <NumberInput id="partner-circuit-threshold" value={asNumber(circuitThreshold)} onChange={(v) => setCircuitThreshold(asText(v))} step={1} placeholder="5" describedBy={describedBy('partner-circuit-threshold', true, false)} />
                      </Field>
                      <Field id="partner-circuit-window" label="Window (seconds)" hint="Time period to count errors in.">
                        <NumberInput id="partner-circuit-window" value={asNumber(circuitWindow)} onChange={(v) => setCircuitWindow(asText(v))} step={1} placeholder="60" describedBy={describedBy('partner-circuit-window', true, false)} />
                      </Field>
                      <Field id="partner-circuit-cooldown" label="Pause duration (seconds)" hint="How long to wait before retrying.">
                        <NumberInput id="partner-circuit-cooldown" value={asNumber(circuitCooldown)} onChange={(v) => setCircuitCooldown(asText(v))} step={1} placeholder="300" describedBy={describedBy('partner-circuit-cooldown', true, false)} />
                      </Field>
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="Response classification">
                {/* The decline group (rejection) is edited in the Buyer profile section beside
                    the accept rules, so it is not repeated here (#1412, L605). The defaults
                    and each list's Alert switch are drawn with the lists (#2143, PM-11). */}
                <ErrorRuleLists
                  value={signalRules}
                  onChange={setSignalRules}
                  alertRetried={alertTransient}
                  onAlertRetried={setAlertTransient}
                  alertNotRetried={alertPermanent}
                  onAlertNotRetried={setAlertPermanent}
                />
              </Section>

              <Section title="Confirmation window">
                {confirmationWindowShown(usage, confirmationWindowMs, confirmationAdded) ? (
                  <>
                    <p className="text-xs text-hint">
                      Used by the Latency Gate node. Maximum acceptable time between our bid and this partner&apos;s
                      Bid Win Confirmation. Confirmations slower than this are rejected (reject due to latency). Leave
                      blank to require a node-level override instead.
                    </p>
                    <Field id="partner-confirmation-window" label="Confirmation window (ms)" hint="e.g. 5000 = 5 seconds.">
                      <NumberInput id="partner-confirmation-window" value={asNumber(confirmationWindowMs)} onChange={(v) => { setConfirmationAdded(true); setConfirmationWindowMs(asText(v)) }} step={1} placeholder="(none)" describedBy={describedBy('partner-confirmation-window', true, false)} />
                    </Field>
                  </>
                ) : (
                  <div className="space-y-1">
                    <Button variant="secondary" onClick={() => setConfirmationAdded(true)}>
                      <Plus className="h-4 w-4" aria-hidden="true" /> Set up a confirmation window
                    </Button>
                    <p className="text-xs text-hint">Used only by a Latency Gate step. No workflow has one for {name || 'this partner'}.</p>
                  </div>
                )}
              </Section>

            </TabPanel>
          )}
          <TabPanel value="workflow_values">
            {/* Each value with the name workflows read it by and who reads it (#2142); the controls are the form's own. */}
            <WorkflowValuesPanel
              partnerId={partner?.id ?? null}
              slug={partner?.slug ?? slug}
              refreshKey={refreshKeyOf(partner?.version ?? 0, uuids)}
              isBuyer={isBuyer}
              isSource={isSource}
              isActive={isActive}
              partnerName={name || partner?.name || 'This partner'}
              controls={{
            click_url: isBuyer ? <>
              {/* The labelled field with its error beside it (#1546): the buyer profile's click URL refusals name this field. */}
              <Field
                id="partner-click-url"
                label="Click URL"
                labelHidden
                hint="Where a lead sold to this buyer lands. A buyer profile cannot be enabled without one."
                error={clickUrlError}
              >
                <TextInput id="partner-click-url" value={clickUrl} onChange={setClickUrl} placeholder="https://partner.com/apply" describedBy={describedBy('partner-click-url', true, Boolean(clickUrlError))} />
              </Field>
            </> : undefined,

            min_bids: isBuyer ? <>
              <p className="text-xs text-hint">
                Optional per-sub-account floor. When a lead arrives with a matching sub-account UUID,
                this floor overrides the partner-wide Minimum bid. Leave empty to use only the partner-wide floor.
              </p>
              <div className="space-y-1.5">
                {subAccountFloors.map((f, i) => (
                  <div key={f.id} className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                    <TextInput
                      id={`floor-${f.id}-uuid`}
                      aria-label={`Sub-account UUID, floor ${i + 1}`}
                      value={f.uuid}
                      onChange={(v) => setSubAccountFloors((prev) => prev.map((row, j) => j === i ? { ...row, uuid: v } : row))}
                      placeholder="sub-account UUID"
                      mono
                      className="text-xs"
                    />
                    <NumberInput
                      id={`floor-${f.id}-bid`}
                      aria-label={`Minimum bid, floor ${i + 1}`}
                      value={asNumber(f.bid)}
                      onChange={(v) => setSubAccountFloors((prev) => prev.map((row, j) => j === i ? { ...row, bid: asText(v) } : row))}
                      step={0.01}
                      placeholder="0.00"
                    />
                    <RemoveButton label={`Remove floor ${i + 1}`} onClick={() => setSubAccountFloors((prev) => prev.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button variant="secondary" onClick={() => setSubAccountFloors((prev) => [...prev, { id: uid(), uuid: '', bid: '' }])} className="text-xs">
                  <Plus size={12} aria-hidden="true" /> Add row
                </Button>
              </div>
            </> : undefined,

            // Edited beside a preview of how it is shown (the settled design's sell-off offer).
            sell_off: isSource ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="min-w-0 space-y-3">
                  <Field id="partner-sell-off-title" label="Title">
                    <TextInput id="partner-sell-off-title" value={sellOffOfferTitle} onChange={setSellOffOfferTitle} placeholder="Get up to $50,000 in your account" />
                  </Field>
                  <Field id="partner-sell-off-details" label="Details">
                    <TextArea
                      id="partner-sell-off-details"
                      value={sellOffOfferDetails}
                      onChange={setSellOffOfferDetails}
                      placeholder="Personal loans from $5,000 to $100,000 with competitive rates."
                      rows={5}
                      mono
                      className="text-xs"
                    />
                  </Field>
                </div>
                <div className="min-w-0">
                  <p className="mb-1 block text-xs font-medium text-gray-600">As shown</p>
                  <OfferPreview title={sellOffOfferTitle} details={sellOffOfferDetails} />
                </div>
              </div>
            ) : undefined,

            sub_account_ids: isSource ? <>
              <p className="text-xs text-hint">
                Sub-account IDs a lead can arrive with, each meaning this partner.
              </p>
              <div className="space-y-1.5">
                {isNew ? (
                  pendingUuids.map((uuid, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <span className="flex-1 truncate font-mono text-xs text-graphite">{uuid}</span>
                      <RemoveButton label="Remove UUID" onClick={() => setPendingUuids((prev) => prev.filter((_, j) => j !== i))} />
                    </div>
                  ))
                ) : uuidsLoadError ? (
                  <FieldError as="div" alert boxed size="sm" className="flex items-center gap-3">
                    <span className="flex-1">Could not load sub-account IDs. Try again.</span>
                    <Button variant="secondary" onClick={() => setUuidsAttempt((n) => n + 1)}>Try again</Button>
                  </FieldError>
                ) : (
                  uuids.map((u) => (
                    <div key={u.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <span className="flex-1 truncate font-mono text-xs text-graphite">{u.uuid}</span>
                      <RemoveButton
                        label="Remove UUID"
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
                      />
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <TextInput
                  id="partner-new-uuid"
                  aria-label="New sub-account UUID"
                  value={newUuid}
                  onChange={(v) => { setNewUuid(v); setUuidError(null) }}
                  placeholder="Enter UUID"
                  mono
                  className="flex-1"
                />
                <Button
                  variant="primary"
                  disabled={!newUuid.trim()}
                  busy={addingUuid}
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
                >
                  {!addingUuid && <Plus className="h-4 w-4" aria-hidden="true" />}
                  Add
                </Button>
              </div>
              {uuidError && <FieldError size="xs">{uuidError}</FieldError>}
            </> : undefined,
              }}
            />
          </TabPanel>
          {!isNew && (
            <TabPanel value="history">
              {partner && <PartnerHistoryPanel partner={partner} shown={tab === 'history'} />}
            </TabPanel>
          )}
        </Tabs>
        )}

      </form>

      {/*
        #2140, PM-13: Delete last on the Partner tab, in its own box outside the
        form, so Enter in its field can never submit the partner. It re-reads
        what a delete would remove whenever it opens and whenever the partner,
        its profile or its sub-account IDs change.
      */}
      {/*
        A delete in flight keeps the box mounted on whatever tab is open, saying
        it is running, so its answer always reaches the page: the server commits
        it whether or not the person stayed on the Partner tab. A refusal or a
        failure stays there too, until the person is back on the Partner tab.
      */}
      {!isNew && onDeleted && (tab === 'partner' || deletePinned) && (
        <PartnerDeleteBox
          partner={{ id: partner.id, name: partner.name }}
          refreshKey={JSON.stringify([partner.version ?? 0, profile?.version ?? null, uuids.map((u) => u.uuid).sort()])}
          onDeleted={(answer) => onDeleted(partner.id, answer)}
          onRunningChange={deleteRunningChanged}
        />
      )}

      {/*
        The save bar (#2138), at the foot of the page's form pane when the page
        gives it one, otherwise after the form. Its Save and Create buttons
        submit this form by id, so Enter in a field still saves.
      */}
      {barSlot ? createPortal(<SaveBarDock bar={bar || null} slideOut={barState?.kind === 'done'} />, barSlot) : <SaveBarDock bar={bar || null} slideOut={barState?.kind === 'done'} />}

      {leaveAsk && (
        <LeaveDialog
          // The partner as stored, as the settled design names it: a rename in progress is one of the changes.
          who={isNew ? 'the new partner' : partner?.name || 'this partner'}
          units={units}
          unconfirmed={saveOutcome.kind !== 'unconfirmed' ? null : now - saveOutcome.since >= UNCONFIRMED_GIVE_UP_MS ? 'gave-up' : 'checking'}
          destination={leaveAsk.destination}
          onKeepEditing={() => setLeaveAsk(null)}
          // Discard means discard: if the way away keeps this page (a link to it), what is left is clean.
          onDiscard={() => { const request = leaveAsk; setLeaveAsk(null); discardChanges(); request.proceed() }}
          onSave={() => { void saveThenLeave(leaveAsk) }}
        />
      )}
    </div>
    </LiveNotesContext.Provider>
  )
}
