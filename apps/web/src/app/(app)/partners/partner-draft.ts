// The partner form's draft (#2132, was partner-body.ts): the form-state snapshot
// mapped to the API body, the field registry every path the page edits is
// listed in, and the draft a save is made from (base, draft, touched), so a save
// sends only what the person changed. Pure, so all of it is testable without
// the React component.
import { FIELD_LABELS, SECTION_LABELS } from '@/components/partners/buyer-profile/labels'
import type { Signal, SignalOperator } from '@bidspoke/buyer-profile'
import type { PartnerBody, BidResolverType, BidComparisonSource, ExtraExtractionConfig } from '@/lib/api'
import type { PartnerType } from '@/lib/partner-roles'
import { listToString, operatorOf, parseList, signalFrom, valueTextOf } from '@/lib/signal-text'

// ── The field registry ──────────────────────────────────────────────────────

/**
 * The page's tabs, as the settled design names them (PRD 6.4.1, PM-1). A
 * field's tab is where the page draws its control (#2137): the settled design
 * puts the circuit breaker, error rules and alerts with the bidding they govern
 * on the Bid Group tab, and the per sub-account minimum bids with the other
 * values workflows read by name on Workflow values.
 */
export type PartnerTab = 'partner' | 'buyer_profile' | 'bid_group' | 'workflow_values' | 'history'

/**
 * One path the page edits. A pattern is a PartnerBody key, or a buyer profile
 * path under PROFILE_PREFIX in the TypeScript spelling, where `[*]` stands for
 * any one row key (`profile.windows[*]` matches `profile.windows[1:540]`).
 */
export interface FieldEntry {
  pattern: string
  tab: PartnerTab
  section: string
  label: string
  /** A row list's rows merge as row groups, never one flattened row at a time (#2134). */
  mergeGroup?: MergeGroup
  /**
   * No tab draws a control for it (#2137): kept so the merge and the history can
   * name a change made outside the page, and a problem with it is said at page
   * level rather than marking a tab with nothing to show.
   */
  offPage?: true
}

/**
 * How a row list merges (#2134). A flattened row's key holds an editable value
 * (a window's opening minute, a tier's lower bound), so moving it would read as
 * a delete plus an add. Rows therefore merge as groups: one group per value of
 * `by` (a day, a population), or the whole list as one group when there is no
 * `by`. A group changed by one side is taken whole from that side; a group both
 * changed to different contents is one question.
 */
export interface MergeGroup {
  name: 'windows' | 'tiers' | 'blackout_dates' | 'click_delivery.routes'
  by?: 'day_of_week' | 'population'
}

/** Buyer profile paths are namespaced: `priority` is both a partner field and a profile field. */
export const PROFILE_PREFIX = 'profile.'

const partnerField = (pattern: keyof PartnerBody, section: string, label: string, tab: PartnerTab = 'partner'): FieldEntry => ({ pattern, tab, section, label })
const profileField = (path: string, section: string, label: string, mergeGroup?: MergeGroup): FieldEntry => ({ pattern: `${PROFILE_PREFIX}${path}`, tab: 'buyer_profile', section, label, ...(mergeGroup ? { mergeGroup } : {}) })

/**
 * Every path the page edits, each exactly once (partner-field-registry.test.ts,
 * and the SQL suite's partner_page_columns.test.sql for the schema side).
 * Profile labels come from the section's own label list (L118).
 */
export const PARTNER_FIELD_REGISTRY: readonly FieldEntry[] = [
  // The Partner tab's rows (#2323, PM-20): Name, Does, Active. The slug is asked
  // only on the new partner page, under its own Slug row, and cannot change once
  // the partner exists, so no tab of a saved partner draws it.
  partnerField('name', 'Name', 'Name'),
  { ...partnerField('slug', 'Slug', 'Slug'), offPage: true },
  partnerField('partner_type', 'Does', 'Does'),
  // List order left the page with the alphabetical list (#2137, PM-1); the column
  // stays in the data, so the merge and the history still name it.
  { ...partnerField('priority', 'Name', 'List order (not shown on this page)'), offPage: true },
  partnerField('is_active', 'Active', 'Active'),
  partnerField('bid_resolver_type', 'Resolver', 'Resolver', 'bid_group'),
  partnerField('bid_resolver_config', 'Bid amount', 'Bid amount settings', 'bid_group'),
  partnerField('bid_formula', 'Bid amount', 'No call expression', 'bid_group'),
  partnerField('api_endpoint', 'Endpoint', 'Address', 'bid_group'),
  partnerField('cf_secret_key', 'Endpoint', 'Secret', 'bid_group'),
  partnerField('bid_comparison_source', 'Bid amount', 'Bid amount', 'bid_group'),
  partnerField('click_url', 'Click URL', 'Click URL', 'workflow_values'),
  partnerField('dedup_endpoint', 'Endpoint', 'Duplicate check address', 'bid_group'),
  partnerField('outbound_field_mapping', 'Request', 'Field mapping', 'bid_group'),
  partnerField('extra_extraction', 'Response', 'Extract', 'bid_group'),
  partnerField('last_probe_response', 'Response', 'Sample answer', 'bid_group'),
  partnerField('daily_cap', 'Limits', 'Daily attempt cap', 'bid_group'),
  partnerField('min_bid', 'Limits', 'Minimum bid', 'bid_group'),
  partnerField('sub_account_min_bids', 'Sub-account minimum bids', 'Sub-account minimum bids', 'workflow_values'),
  partnerField('circuit_enabled', 'Circuit breaker', 'Circuit breaker on', 'bid_group'),
  partnerField('circuit_error_threshold', 'Circuit breaker', 'Errors', 'bid_group'),
  partnerField('circuit_window_seconds', 'Circuit breaker', 'Within (seconds)', 'bid_group'),
  partnerField('circuit_cooldown_seconds', 'Circuit breaker', 'Pause for (seconds)', 'bid_group'),
  partnerField('response_classification', 'Errors', 'Error rules', 'bid_group'),
  partnerField('confirmation_window_ms', 'Confirmation window', 'Confirmation window (ms)', 'bid_group'),
  partnerField('sell_off_offer_title', 'Sell-off offer', 'Sell-off offer title', 'workflow_values'),
  partnerField('sell_off_offer_details', 'Sell-off offer', 'Sell-off offer details', 'workflow_values'),
  partnerField('alert_config', 'Errors', 'Alerts', 'bid_group'),
  partnerField('accept_signals', 'Outcome rules', SECTION_LABELS.accept_signals, 'buyer_profile'),
  partnerField('duplicate_signals', 'Outcome rules', SECTION_LABELS.duplicate_signals, 'buyer_profile'),
  partnerField('external_routing_code', 'Sale', FIELD_LABELS.external_routing_code, 'buyer_profile'),
  profileField('sold_on', 'Sold on', FIELD_LABELS.sold_on),
  profileField('is_enabled', 'Enabled', FIELD_LABELS.is_enabled),
  profileField('priority', 'Priority', FIELD_LABELS.priority),
  profileField('allowed_states', 'Eligibility', FIELD_LABELS.allowed_states),
  profileField('debt_min', 'Eligibility', FIELD_LABELS.debt_min),
  profileField('debt_max', 'Eligibility', FIELD_LABELS.debt_max),
  profileField('loan_amount_min', 'Eligibility', FIELD_LABELS.loan_amount_min),
  // #2111 stores it; #2268 gave it its field on the page.
  profileField('collections_max_percent', 'Eligibility', FIELD_LABELS.collections_max_percent),
  profileField('hourly_lead_cap', 'Caps', FIELD_LABELS.hourly_lead_cap),
  profileField('daily_lead_cap', 'Caps', FIELD_LABELS.daily_lead_cap),
  profileField('hourly_spend_cap_cents', 'Caps', FIELD_LABELS.hourly_spend_cap_cents),
  profileField('daily_spend_cap_cents', 'Caps', FIELD_LABELS.daily_spend_cap_cents),
  profileField('display_time_zone', SECTION_LABELS.windows, FIELD_LABELS.display_time_zone),
  profileField('windows[*]', SECTION_LABELS.windows, SECTION_LABELS.windows, { name: 'windows', by: 'day_of_week' }),
  profileField('blackout_dates[*]', SECTION_LABELS.blackout_dates, SECTION_LABELS.blackout_dates, { name: 'blackout_dates' }),
  profileField('tiers[*]', SECTION_LABELS.tiers, SECTION_LABELS.tiers, { name: 'tiers', by: 'population' }),
  profileField('click_delivery.success_pattern', 'Click delivery', 'Success reply'),
  profileField('click_delivery.routes[*]', 'Click delivery', 'Routes', { name: 'click_delivery.routes' }),
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const toRe = (pattern: string): RegExp => new RegExp(`^${escapeRe(pattern).replace(/\\\[\\\*\\\]/g, '\\[[^\\]]+\\]')}$`)
const PATTERN_RES = new Map(PARTNER_FIELD_REGISTRY.map((e) => [e.pattern, toRe(e.pattern)]))
const patternRe = (pattern: string): RegExp => PATTERN_RES.get(pattern) ?? toRe(pattern)

/** The registry entries a path matches; exactly one for every path the page edits. */
export function registryEntriesFor(path: string, registry: readonly FieldEntry[] = PARTNER_FIELD_REGISTRY): FieldEntry[] {
  return registry.filter((e) => patternRe(e.pattern).test(path))
}

/**
 * Every key of PartnerBody, enumerated through a record keyed by the type, so a
 * key added to the type without one here does not compile, and the registry
 * test then holds it to a registry entry.
 */
const PARTNER_BODY_KEY_RECORD: Record<keyof PartnerBody, true> = {
  name: true, slug: true, api_endpoint: true, cf_secret_key: true, daily_cap: true, min_bid: true, bid_formula: true,
  bid_resolver_type: true, bid_resolver_config: true, outbound_field_mapping: true, bid_comparison_source: true,
  extra_extraction: true, last_probe_response: true, dedup_endpoint: true, response_classification: true, accept_signals: true,
  duplicate_signals: true, external_routing_code: true, alert_config: true, circuit_error_threshold: true, circuit_window_seconds: true,
  circuit_cooldown_seconds: true, circuit_enabled: true, confirmation_window_ms: true, is_active: true, priority: true,
  sell_off_offer_title: true, sell_off_offer_details: true, click_url: true, sub_account_min_bids: true, partner_type: true,
}
export const PARTNER_BODY_KEYS = Object.keys(PARTNER_BODY_KEY_RECORD) as (keyof PartnerBody)[]

// ── The draft a save is made from ───────────────────────────────────────────

type PartnerBodyKey = keyof PartnerBody

/**
 * base: the partner as the page loaded or last saved it. draft: as it is on
 * screen now. touched: every key an edit changed since base, kept even when an
 * edit puts it back, because the person has spoken about it (PR4's live merge
 * leaves those alone).
 */
export interface PartnerDraft {
  base: PartnerBody
  draft: PartnerBody
  touched: ReadonlySet<PartnerBodyKey>
}

export type DraftAction =
  /** The form's current values, built by buildPartnerBody. */
  | { type: 'observe'; draft: PartnerBody }
  /** A save landed (or the page reloaded the row): this is the new base. */
  | { type: 'rebase'; base: PartnerBody }

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function initDraft(base: PartnerBody): PartnerDraft {
  return { base, draft: base, touched: new Set() }
}

export function draftReducer(state: PartnerDraft, action: DraftAction): PartnerDraft {
  if (action.type === 'rebase') {
    const touched = new Set([...state.touched].filter((k) => !sameValue(state.draft[k], action.base[k])))
    return { base: action.base, draft: state.draft, touched }
  }
  const touched = new Set(state.touched)
  for (const k of PARTNER_BODY_KEYS) {
    if (!sameValue(action.draft[k], state.draft[k])) touched.add(k)
  }
  if (touched.size === state.touched.size && sameValue(action.draft, state.draft)) return state
  return { base: state.base, draft: action.draft, touched }
}

/** What a save sends: each touched key whose value differs from base. */
export function changedPatch(state: PartnerDraft): Partial<PartnerBody> {
  const out: Record<string, unknown> = {}
  for (const k of PARTNER_BODY_KEYS) {
    if (state.touched.has(k) && !sameValue(state.draft[k], state.base[k])) out[k] = state.draft[k] ?? null
  }
  return out as Partial<PartnerBody>
}

/** The save that undoes `patch`: each key it sent, back to its value in `before`. */
export function inversePatch(patch: Partial<PartnerBody>, before: PartnerBody): Partial<PartnerBody> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(patch) as PartnerBodyKey[]) out[k] = before[k] ?? null
  return out as Partial<PartnerBody>
}

export { listToString, parseList }

/** A body rule's condition IS a signal operator: one vocabulary for both rule editors (#1463, L611). */
export type BodyCondition = SignalOperator
export type StatusCondition = 'contains' | 'in' | 'not_in' | 'present'
export type SignalCategory = 'rejection' | 'transient' | 'permanent'

export interface BodyRule { id: string; kind: 'body'; field: string; condition: BodyCondition; value: string }
export interface StatusRule { id: string; kind: 'status'; code: string; bodyField: string; condition: StatusCondition; value: string }
export type Rule = BodyRule | StatusRule
export type SignalRules = Record<SignalCategory, Rule[]>

export interface SubAccountFloor { id: string; uuid: string; bid: string }

export interface FormSnapshot {
  name: string; apiEndpoint: string; cfSecretKey: string; clickUrl: string; isActive: boolean
  priority: string; dailyCap: string; minBid: string; bidFormula: string
  resolverType: BidResolverType; resolverConfig: Record<string, unknown>
  outboundMapping: Record<string, unknown> | null
  bidComparisonSource: BidComparisonSource
  extraExtraction: ExtraExtractionConfig | null; lastProbeResponse: unknown
  dedupEndpoint: string; circuitEnabled: boolean; circuitThreshold: string
  circuitWindow: string; circuitCooldown: string; signalRules: SignalRules
  alertTransient: boolean; alertPermanent: boolean
  sellOffOfferTitle: string; sellOffOfferDetails: string
  partnerType: PartnerType
  confirmationWindowMs: string
  subAccountFloors: SubAccountFloor[]
  /** The buyer_select accept rules (#1412), the shared Signal shape, saved with the partner record. */
  acceptSignals: unknown[]
  /** The Salesforce routing code as typed, a whole number or blank (#1416). */
  externalRoutingCode: string
  /** The duplicate rules (#1416), the shared Signal shape, saved with the partner record. */
  duplicateSignals: unknown[]
}

/** A routing code is a whole number Salesforce recognises or nothing at all: a fraction or a word is null, never a rounded guess (L50). */
/**
 * A number box's text as the number typed, or null when it is empty (#2328).
 * Never rounded or defaulted here: 2.5 stays 2.5 and 0 stays 0, so the save's
 * shared rule (partnerNumberErrors) refuses it with a reason instead of the
 * page quietly storing something nobody typed.
 */
export function numberOrNull(text: string): number | null {
  const t = text.trim()
  return t === '' ? null : Number(t)
}

export function parseRoutingCode(text: string): number | null {
  const t = text.trim()
  return /^\d+$/.test(t) ? parseInt(t, 10) : null
}

function uid() { return Math.random().toString(36).slice(2) }

/**
 * The stored response_classification as rule rows. A body signal is read
 * through the shared mapping, so every operator the classifier knows comes back
 * as itself: before #1463 the two array operators were read as a blank equals
 * and written back that way on the next save, destroying the rule (L652).
 */
export function parseRules(raw: unknown): SignalRules {
  const result: SignalRules = { rejection: [], transient: [], permanent: [] }
  if (!raw || typeof raw !== 'object') return result
  const obj = raw as Record<string, unknown>
  const map: [string, SignalCategory][] = [
    ['rejection_signals', 'rejection'],
    ['transient_signals', 'transient'],
    ['permanent_signals', 'permanent'],
  ]
  for (const [key, cat] of map) {
    if (!Array.isArray(obj[key])) continue
    for (const sig of obj[key] as Record<string, unknown>[]) {
      if (sig.field != null) {
        const signal = { ...sig, field: String(sig.field) } as Signal
        result[cat].push({ id: uid(), kind: 'body', field: signal.field, condition: operatorOf(signal), value: valueTextOf(signal) })
      } else if (sig.status_code != null || sig.body_field != null || sig.header != null) {
        let condition: StatusCondition = 'contains'
        let value = ''
        if (sig.present === true)            { condition = 'present' }
        else if (Array.isArray(sig.not_in))  { condition = 'not_in';  value = listToString(sig.not_in) }
        else if (Array.isArray(sig.in))      { condition = 'in';      value = listToString(sig.in) }
        else if (sig.contains != null)       { value = String(sig.contains) }
        result[cat].push({
          id: uid(), kind: 'status',
          code:      sig.status_code != null ? String(sig.status_code) : '',
          bodyField: String(sig.body_field ?? sig.header ?? ''),
          condition, value,
        })
      }
    }
  }
  return result
}

/** The stored per sub account floors as editable rows. */
export function floorsFromMap(map: Record<string, number> | null | undefined): SubAccountFloor[] {
  if (!map) return []
  return Object.entries(map).map(([uuid, bid]) => ({ id: uid(), uuid, bid: String(bid) }))
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The form's values for a partner (#2134): the one mapping from a stored row, or
 * a body the merge built, to what the form shows, so the page's initial state
 * and a merged save cannot disagree about a default. The inverse of
 * buildPartnerBody: buildPartnerBody(snapshotOf(body)) is body again.
 *
 * `prev` keeps the rows the form already has when they say the same thing, so
 * their row ids (and with them what reads as edited) do not change under a
 * person when a merge puts back what was already on screen.
 */
export function snapshotOf(partner: PartnerBody | undefined, prev?: FormSnapshot): FormSnapshot {
  const p = partner ?? {}
  const alerts = p.alert_config as { transient_errors?: { alert?: boolean }; permanent_errors?: { alert?: boolean } } | null | undefined
  const rules = prev && sameJson(serializeRules(prev.signalRules), p.response_classification) ? prev.signalRules : parseRules(p.response_classification)
  const floors = prev && sameJson(floorsToMap(prev.subAccountFloors), p.sub_account_min_bids ?? null) ? prev.subAccountFloors : floorsFromMap(p.sub_account_min_bids)
  return {
    name: p.name ?? '',
    apiEndpoint: p.api_endpoint ?? '',
    cfSecretKey: p.cf_secret_key ?? '',
    clickUrl: p.click_url ?? '',
    isActive: p.is_active ?? true,
    priority: String(p.priority ?? 0),
    dailyCap: p.daily_cap != null ? String(p.daily_cap) : '',
    minBid: p.min_bid != null ? String(p.min_bid) : '',
    bidFormula: p.bid_formula ?? '',
    resolverType: p.bid_resolver_type ?? 'api',
    resolverConfig: p.bid_resolver_config ?? {},
    outboundMapping: p.outbound_field_mapping ?? null,
    bidComparisonSource: p.bid_comparison_source ?? 'auto',
    extraExtraction: p.extra_extraction ?? null,
    lastProbeResponse: p.last_probe_response ?? null,
    dedupEndpoint: p.dedup_endpoint ?? '',
    circuitEnabled: p.circuit_enabled ?? true,
    circuitThreshold: String(p.circuit_error_threshold ?? 5),
    circuitWindow: String(p.circuit_window_seconds ?? 60),
    circuitCooldown: String(p.circuit_cooldown_seconds ?? 300),
    signalRules: rules,
    alertTransient: alerts?.transient_errors?.alert !== false,
    alertPermanent: alerts?.permanent_errors?.alert !== false,
    sellOffOfferTitle: p.sell_off_offer_title ?? '',
    sellOffOfferDetails: p.sell_off_offer_details ?? '',
    partnerType: p.partner_type ?? 'buyer',
    confirmationWindowMs: p.confirmation_window_ms != null ? String(p.confirmation_window_ms) : '',
    subAccountFloors: floors,
    acceptSignals: Array.isArray(p.accept_signals) ? p.accept_signals : [],
    externalRoutingCode: p.external_routing_code != null ? String(p.external_routing_code) : '',
    duplicateSignals: Array.isArray(p.duplicate_signals) ? p.duplicate_signals : [],
  }
}

export function floorsToMap(floors: SubAccountFloor[]): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const f of floors) {
    const uuid = f.uuid.trim()
    if (!uuid) continue
    // A blank bid is "no override", not a $0 floor. Number('') === 0 passes
    // isFinite, so without this guard an unfilled row would persist a floor of
    // 0, which accepts any bid and silently bypasses the partner-wide min_bid.
    // Treat blank or non-positive as no floor.
    if (f.bid.trim() === '') continue
    const n = Number(f.bid)
    if (!Number.isFinite(n) || n <= 0) continue
    out[uuid] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

export function serializeRules(rules: SignalRules): unknown {
  const map: [SignalCategory, string][] = [
    ['rejection', 'rejection_signals'],
    ['transient', 'transient_signals'],
    ['permanent', 'permanent_signals'],
  ]
  const result: Record<string, unknown[]> = {}
  let hasAny = false
  for (const [cat, key] of map) {
    const signals: unknown[] = []
    for (const r of rules[cat]) {
      if (r.kind === 'body' && r.field.trim()) {
        signals.push(signalFrom(r.field, r.condition, r.value))
      } else if (r.kind === 'status' && (r.code.trim() || r.bodyField.trim())) {
        const obj: Record<string, unknown> = {}
        if (r.code.trim())      obj.status_code = Number(r.code)
        if (r.bodyField.trim()) obj.body_field   = r.bodyField
        if (r.condition === 'present')        obj.present  = true
        else if (r.condition === 'in')        obj.in       = parseList(r.value)
        else if (r.condition === 'not_in')    obj.not_in   = parseList(r.value)
        else if (r.value.trim())              obj.contains = r.value
        signals.push(obj)
      }
    }
    if (signals.length > 0) { result[key] = signals; hasAny = true }
  }
  return hasAny ? result : null
}

/** Build the API body from a form snapshot. Used by Save and by Undo's re-save
 *  (#98): keep every field in sync with the form's own submit. */
export function buildPartnerBody(snap: FormSnapshot, ctx: { slug: string; isExisting: boolean }): PartnerBody {
  return {
    name: snap.name,
    slug: ctx.isExisting ? undefined : ctx.slug,
    partner_type: snap.partnerType,
    api_endpoint: snap.apiEndpoint || null,
    cf_secret_key: snap.cfSecretKey || null,
    click_url: snap.clickUrl || null,
    is_active: snap.isActive,
    priority: parseInt(snap.priority) || 0,
    daily_cap: numberOrNull(snap.dailyCap),
    min_bid: snap.minBid ? parseFloat(snap.minBid) : null,
    bid_formula: snap.bidFormula || null,
    bid_resolver_type: snap.resolverType,
    bid_resolver_config: snap.resolverConfig,
    outbound_field_mapping: snap.outboundMapping,
    bid_comparison_source: snap.bidComparisonSource,
    extra_extraction: snap.extraExtraction,
    last_probe_response: snap.lastProbeResponse,
    dedup_endpoint: snap.dedupEndpoint || null,
    circuit_enabled: snap.circuitEnabled,
    circuit_error_threshold: numberOrNull(snap.circuitThreshold) ?? 5,
    circuit_window_seconds: parseInt(snap.circuitWindow) || 60,
    circuit_cooldown_seconds: parseInt(snap.circuitCooldown) || 300,
    response_classification: serializeRules(snap.signalRules),
    accept_signals: snap.acceptSignals,
    duplicate_signals: snap.duplicateSignals,
    external_routing_code: numberOrNull(snap.externalRoutingCode),
    alert_config: {
      transient_errors: { alert: snap.alertTransient },
      permanent_errors: { alert: snap.alertPermanent },
    },
    sell_off_offer_title: snap.sellOffOfferTitle || null,
    sell_off_offer_details: snap.sellOffOfferDetails || null,
    sub_account_min_bids: floorsToMap(snap.subAccountFloors),
    confirmation_window_ms: numberOrNull(snap.confirmationWindowMs),
  }
}
